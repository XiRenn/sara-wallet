/**
 * Transaction service.
 *
 * The wallet balance is maintained by a PostgreSQL trigger
 * (`tg_transactions_apply_balance`), so this layer never writes to
 * `wallets.balance`. After a mutation the caller should re-read the wallet
 * (the hooks do this automatically) to pick up the new balance.
 */

import { getSupabase } from '../config/supabase';
import type { TransactionRow, TransactionType, TransactionUpdate } from '../types/database';
import { toNumber } from '../types/wallet';
import { AppError, toAppError, unwrap } from '../utils/errors';
import { toDateBound, toISODate, toMonthStart, type DateInput } from '../utils/date';
import {
  assertNonEmptyString,
  assertOptionalString,
  assertPositiveAmount,
  assertUuid,
} from '../utils/validate';
import { requireUserId } from './auth';

const TABLE = 'transactions' as const;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Hard ceiling on one page. Without it a mistyped `limit` asks PostgREST for
 * the whole table and the device quietly tries to hold it in memory.
 */
export const MAX_PAGE_SIZE = 200;

/* -------------------------------------------------------------------------- */
/* Domain types                                                                */
/* -------------------------------------------------------------------------- */

/** A transaction exactly as it is stored, with numeric fields coerced. */
export type Transaction = Omit<TransactionRow, 'amount'> & {
  amount: number;
  /**
   * For a leg of a wallet-to-wallet transfer, the wallet at the *other* end.
   * `null` for every ordinary row.
   *
   * Derived, never stored. The two legs are independent rows that only
   * `transfer_group_id` links, so a line on its own knows one wallet and the
   * direction is invisible: money leaving iWallet for Cash reads as a line
   * labelled `iWallet` and another labelled `Cash`, with nothing to say they
   * are the same movement. The ledger shows both ends from this.
   *
   * Resolved by `getTransactionsPage`, so it is only populated on rows that
   * came through there — a row built by `addTransaction` has no sibling yet.
   */
  transfer_counterpart_wallet_id: string | null;
};

export interface AddTransactionInput {
  walletId: string;
  type: TransactionType;
  amount: number;
  category?: string;
  note?: string | null;
  /** Defaults to now. Back-dating is supported. */
  date?: DateInput;
  /**
   * Settles the given debt with this row.
   *
   * A settlement is an ordinary ledger row — it moves the wallet balance like
   * any other — so it is written through this one path rather than a second
   * insert in the debt service. The database decides whether the link is
   * legal: `tg_transactions_validate_debt_link` refuses a type that disagrees
   * with the debt's direction, a wallet in the wrong currency, and any
   * overpayment. `settleDebt()` in the debt service is the friendly wrapper.
   */
  debtId?: string | null;
}

export interface UpdateTransactionInput {
  amount?: number;
  category?: string;
  note?: string | null;
  date?: DateInput;
  type?: TransactionType;
  walletId?: string;
}

export interface TransactionQueryOptions {
  limit?: number;
  offset?: number;
  from?: DateInput;
  to?: DateInput;
  type?: TransactionType;
  category?: string;
  /** Free text matched against `note` and `category`. */
  search?: string;
  /** Defaults to newest first. */
  ascending?: boolean;
  /** Restrict to the settlements of one debt. */
  debtId?: string | null;
}

/**
 * The accepted input for any paged ledger read.
 *
 * Named rather than repeated inline because `buildTransactionQuery` and
 * `getTransactionsPage` take the same shape, and a field added to one but not
 * the other is a filter that silently does nothing.
 */
export interface TransactionQueryInput {
  walletId?: string | null;
  limit?: number;
  offset?: number;
  ascending?: boolean;
  search?: string;
  type?: TransactionType | null;
  category?: string | null;
  from?: DateInput;
  to?: DateInput;
  /** Restrict to the settlements of one debt. */
  debtId?: string | null;
}

export interface TransactionPage {
  rows: Transaction[];
  /** True when at least one more row exists past the end of this page. */
  hasMore: boolean;
}

export interface MonthlySummary {
  /** `'YYYY-MM'` of the month the summary covers. */
  month: string;
  walletId: string | null;
  /** Real income only — transfer legs are excluded. */
  income: number;
  /** Real spending only — transfer legs are excluded. */
  expense: number;
  /** `income - expense`. Negative means the month spent more than it earned. */
  net: number;
  /** Every ledger row in range, transfers included. */
  transactionCount: number;
  /**
   * Money that left this wallet by transfer. Reported separately because
   * moving money between your own wallets is not income or spending — counting
   * it as either would make a month look twice as busy as it was.
   */
  transferVolume: number;
}

export interface CategoryBreakdownEntry {
  category: string;
  total: number;
  count: number;
  /** Share of the group total, 0–1. */
  share: number;
}

/* -------------------------------------------------------------------------- */
/* Mappers                                                                     */
/* -------------------------------------------------------------------------- */

function normaliseTransaction(row: TransactionRow): Transaction {
  return { ...row, amount: toNumber(row.amount), transfer_counterpart_wallet_id: null };
}

/* -------------------------------------------------------------------------- */
/* Transfer counterparts                                                       */
/* -------------------------------------------------------------------------- */

/** The two ends of one transfer, keyed by `transfer_group_id`. */
export interface TransferEnds {
  /** The wallet the money left. Written as the `EXPENSE` leg. */
  fromWalletId: string;
  /** The wallet the money arrived in. Written as the `INCOME` leg. */
  toWalletId: string;
}

/**
 * Collapses sibling transfer legs into `from → to`, keyed by group.
 *
 * Exported for the tests: the ordering rule (EXPENSE is the source) is the
 * whole contract, and it has to agree with what `transfer_between_wallets`
 * writes or every transfer renders backwards.
 */
export function resolveTransferEnds(
  legs: readonly Pick<TransactionRow, 'transfer_group_id' | 'wallet_id' | 'type'>[],
): Map<string, TransferEnds> {
  const partial = new Map<string, { from?: string; to?: string }>();

  for (const leg of legs) {
    if (!leg.transfer_group_id) continue;
    const entry = partial.get(leg.transfer_group_id) ?? {};
    if (leg.type === 'EXPENSE') entry.from = leg.wallet_id;
    else entry.to = leg.wallet_id;
    partial.set(leg.transfer_group_id, entry);
  }

  const ends = new Map<string, TransferEnds>();
  for (const [group, { from, to }] of partial) {
    /* A half-written transfer should not happen — the RPC writes both legs in
       one transaction — but a missing sibling must degrade to the plain
       single-wallet cell rather than render a half-known pair. */
    if (from && to) ends.set(group, { fromWalletId: from, toWalletId: to });
  }
  return ends;
}

/**
 * Fills in `transfer_counterpart_wallet_id` for the transfer legs on a page.
 *
 * Looked up by group rather than read off the page, because the sibling is
 * routinely *absent* from it: a wallet-scoped ledger shows one leg and never
 * the other, and a date-scoped one can split a pair across a month boundary.
 *
 * One round trip, and none at all on the overwhelmingly common page that has
 * no transfers on it.
 */
async function attachTransferCounterparts(
  rows: Transaction[],
  userId: string,
): Promise<Transaction[]> {
  const groups = [
    ...new Set(
      rows
        .map((row) => row.transfer_group_id)
        .filter((group): group is string => group !== null),
    ),
  ];
  if (groups.length === 0) return rows;

  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('transfer_group_id, wallet_id, type')
    .eq('user_id', userId)
    .in('transfer_group_id', groups);

  if (error) throw toAppError(error, 'We could not load those transactions.');

  const ends = resolveTransferEnds(data ?? []);

  return rows.map((row) => {
    if (!row.transfer_group_id) return row;
    const pair = ends.get(row.transfer_group_id);
    if (!pair) return row;
    const counterpart = row.type === 'EXPENSE' ? pair.toWalletId : pair.fromWalletId;
    return { ...row, transfer_counterpart_wallet_id: counterpart };
  });
}

/* -------------------------------------------------------------------------- */
/* Query building                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A validated, normalised query — every optional field resolved to either a
 * usable value or `null`. Split out from the round trip so the messy parts
 * (clamping, escaping, date validation) can be tested without a network.
 */
export interface TransactionQuery {
  walletId: string | null;
  limit: number;
  offset: number;
  ascending: boolean;
  /** A ready-to-use PostgREST `ilike` pattern, or `null` when not searching. */
  searchPattern: string | null;
  type: TransactionType | null;
  category: string | null;
  from: string | null;
  to: string | null;
  /** Non-null when the read is scoped to one debt's settlements. */
  debtId: string | null;
}

/** Clamps a real number into `[min, max]`; a non-number falls back instead. */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Turns free text into a PostgREST `ilike` pattern.
 *
 * Two escaping layers, and both are load-bearing:
 *
 *   1. `%` and `_` are LIKE wildcards. A user searching for "50%" means the
 *      literal characters, so they are backslash-escaped.
 *   2. The whole value is wrapped in double quotes. PostgREST parses the
 *      `or=(...)` argument as a logic tree where `,` separates branches and
 *      `.` separates column from operator — unquoted, a note search for
 *      "lunch, then coffee" would be read as a second filter and rejected.
 *
 * A literal `"` would have to be doubled to survive the quoting, and nobody
 * searches for one, so it is dropped rather than escaped. Returns `null` when
 * nothing searchable is left, so the caller can skip the filter entirely
 * instead of matching every row.
 */
export function searchPattern(term: string): string | null {
  const cleaned = term.trim().replace(/"/g, '');
  if (cleaned.length === 0) return null;
  const escaped = cleaned.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `"%${escaped}%"`;
}

export function buildTransactionQuery(
  input: TransactionQueryInput = {},
): TransactionQuery {
  return {
    walletId: input.walletId ? assertUuid(input.walletId, 'walletId') : null,
    limit: clampInt(input.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    offset: clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0),
    ascending: input.ascending ?? false,
    searchPattern: searchPattern(input.search ?? ''),
    type: input.type ?? null,
    category: input.category ? assertNonEmptyString(input.category, 'category', 60) : null,
    from: input.from === undefined ? null : toDateBound(input.from, 'from'),
    to: input.to === undefined ? null : toDateBound(input.to, 'to'),
    debtId: input.debtId ? assertUuid(input.debtId, 'debtId') : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One page of the signed-in user's ledger, newest first by default.
 *
 * The row cap that used to live in `useTransactions` was invisible: a user
 * with 300 transactions saw 50 and had no way to reach the rest. This is the
 * replacement — ask for a page, get `hasMore`, ask again.
 *
 * `hasMore` comes from requesting `limit + 1` rows and seeing whether the
 * extra one arrived, which costs one row rather than a second `count=exact`
 * round trip.
 *
 * Ordering is `date`, then `created_at`, then `id`. `date` is a `date` column,
 * so a busy day produces many ties; with an unstable sort the database is free
 * to return them in a different order for each page, and offset paging then
 * repeats some rows and skips others. `id` is unique, which makes the order
 * total and the paging correct.
 */
export async function getTransactionsPage(
  input: TransactionQueryInput = {},
): Promise<TransactionPage> {
  const query = buildTransactionQuery(input);
  const userId = await requireUserId();

  try {
    let request = getSupabase()
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .range(query.offset, query.offset + query.limit)
      .order('date', { ascending: query.ascending })
      .order('created_at', { ascending: query.ascending })
      .order('id', { ascending: query.ascending });

    if (query.walletId) request = request.eq('wallet_id', query.walletId);
    if (query.debtId) request = request.eq('debt_id', query.debtId);
    if (query.from) request = request.gte('date', query.from);
    if (query.to) request = request.lte('date', query.to);
    if (query.type) request = request.eq('type', query.type);
    if (query.category) request = request.eq('category', query.category);
    if (query.searchPattern) {
      const { searchPattern: pattern } = query;
      request = request.or(`note.ilike.${pattern},category.ilike.${pattern}`);
    }

    const { data, error } = await request;
    if (error) throw toAppError(error, 'We could not load those transactions.');

    const fetched = (data ?? []).map(normaliseTransaction);
    const hasMore = fetched.length > query.limit;
    const page = hasMore ? fetched.slice(0, query.limit) : fetched;

    return { rows: await attachTransferCounterparts(page, userId), hasMore };
  } catch (error) {
    throw toAppError(error, 'We could not load those transactions.');
  }
}

/**
 * Transactions belonging to one wallet.
 * Uses the `(wallet_id, date desc)` composite index.
 */
export async function getTransactionsByWallet(
  walletId: string,
  options: TransactionQueryOptions = {},
): Promise<Transaction[]> {
  const { rows } = await getTransactionsPage({ ...options, walletId });
  return rows;
}

/** The most recent transactions across every wallet. */
export async function getRecentTransactions(limit = 20): Promise<Transaction[]> {
  const { rows } = await getTransactionsPage({ limit });
  return rows;
}

/**
 * All transactions in a window — used by the "This month" screen.
 *
 * Unbounded on purpose: the caller is an aggregation (`getCategoryBreakdown`),
 * not a list, so it needs every row rather than a page. PostgREST caps a
 * response at 1000 rows by default, which is far past any plausible month —
 * if that ever changes, this needs to page too.
 */
export async function getTransactionsInRange(
  from: DateInput,
  to: DateInput,
  walletId?: string | null,
): Promise<Transaction[]> {
  const userId = await requireUserId();

  try {
    let query = getSupabase()
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .gte('date', toDateBound(from, 'from'))
      .lte('date', toDateBound(to, 'to'))
      .order('date', { ascending: false });

    if (walletId) query = query.eq('wallet_id', assertUuid(walletId, 'walletId'));

    const { data, error } = await query;
    if (error) throw toAppError(error, 'We could not load those transactions.');

    return (data ?? []).map(normaliseTransaction);
  } catch (error) {
    throw toAppError(error, 'We could not load those transactions.');
  }
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Records a transaction.
 *
 * The database trigger updates `wallets.balance` in the same transaction, so
 * a returned row means the balance has already moved.
 */
export async function addTransaction(
  input: AddTransactionInput,
): Promise<Transaction> {
  const walletId = assertUuid(input.walletId, 'walletId');
  const amount = assertPositiveAmount(input.amount, 'amount');
  const category = input.category
    ? assertNonEmptyString(input.category, 'category', 60)
    : 'General';
  const note = assertOptionalString(input.note ?? undefined, 'note', 500) ?? null;
  const date = toDateBound(input.date, 'date');

  if (input.type !== 'INCOME' && input.type !== 'EXPENSE') {
    throw new AppError(
      '`type` must be either INCOME or EXPENSE.',
      'validation_error',
      input.type,
    );
  }

  const userId = await requireUserId();

  try {
    const result = await getSupabase()
      .from(TABLE)
      .insert({
        wallet_id: walletId,
        user_id: userId,
        type: input.type,
        amount,
        category,
        note,
        date,
        debt_id: input.debtId ? assertUuid(input.debtId, 'debtId') : null,
      })
      .select('*')
      .single();

    return normaliseTransaction(unwrap(result, 'We could not save that transaction.'));
  } catch (error) {
    throw toAppError(error, 'We could not save that transaction.');
  }
}

/** Patches a transaction. The trigger recalculates the balance automatically. */
export async function updateTransaction(
  transactionId: string,
  patch: UpdateTransactionInput,
): Promise<Transaction> {
  const id = assertUuid(transactionId, 'transactionId');

  // Typed as the generated Update shape so PostgREST's excess-property
  // rejection never sees an unexpected key.
  const payload: TransactionUpdate = {};
  if (patch.amount !== undefined) payload.amount = assertPositiveAmount(patch.amount);
  if (patch.category !== undefined) {
    payload.category = assertNonEmptyString(patch.category, 'category', 60);
  }
  if (patch.note !== undefined) {
    payload.note = assertOptionalString(patch.note ?? undefined, 'note', 500) ?? null;
  }
  if (patch.date !== undefined) payload.date = toDateBound(patch.date, 'date');
  if (patch.type !== undefined) {
    if (patch.type !== 'INCOME' && patch.type !== 'EXPENSE') {
      throw new AppError('`type` must be INCOME or EXPENSE.', 'validation_error');
    }
    payload.type = patch.type;
  }
  if (patch.walletId !== undefined) {
    payload.wallet_id = assertUuid(patch.walletId, 'walletId');
  }

  if (Object.keys(payload).length === 0) {
    throw new AppError('Nothing to update.', 'validation_error');
  }

  try {
    const result = await getSupabase()
      .from(TABLE)
      .update(payload)
      .eq('id', id)
      .select('*')
      .single();

    return normaliseTransaction(
      unwrap(result, 'We could not update that transaction.'),
    );
  } catch (error) {
    throw toAppError(error, 'We could not update that transaction.');
  }
}

/** Deletes a transaction. Returns the number of rows removed (0 or 1). */
export async function deleteTransaction(transactionId: string): Promise<number> {
  const id = assertUuid(transactionId, 'transactionId');

  try {
    const { data, error } = await getSupabase()
      .from(TABLE)
      .delete()
      .eq('id', id)
      .select('id');

    if (error) throw toAppError(error, 'We could not delete that transaction.');
    return data?.length ?? 0;
  } catch (error) {
    throw toAppError(error, 'We could not delete that transaction.');
  }
}

/* -------------------------------------------------------------------------- */
/* Transfers                                                                   */
/* -------------------------------------------------------------------------- */

export interface TransferInput {
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  note?: string | null;
  date?: DateInput;
}

export interface TransferResult {
  /** Shared by both ledger legs. Delete either leg to remove the pair. */
  transferGroupId: string;
}

/**
 * Moves money between two wallets the user owns.
 *
 * This is deliberately **one** round trip rather than two `addTransaction`
 * calls: the two ledger legs must both exist or neither. Recording them
 * separately from the client means a network drop between the calls leaves the
 * money gone from one wallet and absent from the other, with nothing to show
 * the user. `transfer_between_wallets` writes the pair inside a single database
 * transaction.
 *
 * The two wallets must share a currency — converting needs an exchange rate,
 * which this app does not model. The function raises rather than assuming 1:1.
 */
export async function transferBetweenWallets(
  input: TransferInput,
): Promise<TransferResult> {
  const fromWalletId = assertUuid(input.fromWalletId, 'fromWalletId');
  const toWalletId = assertUuid(input.toWalletId, 'toWalletId');

  if (fromWalletId === toWalletId) {
    throw new AppError('Choose two different wallets.', 'validation_error');
  }

  const amount = assertPositiveAmount(input.amount, 'amount');
  const note = assertOptionalString(input.note ?? undefined, 'note', 500) ?? null;
  const date = toDateBound(input.date, 'date');

  // Fail with a readable message before spending a round trip.
  await requireUserId();

  try {
    const { data, error } = await getSupabase().rpc('transfer_between_wallets', {
      p_from_wallet_id: fromWalletId,
      p_to_wallet_id: toWalletId,
      p_amount: amount,
      p_note: note,
      p_date: date,
    });

    if (error) throw toAppError(error, 'We could not complete that transfer.');

    if (typeof data !== 'string' || data.length === 0) {
      throw new AppError(
        'The transfer was saved but no group id came back.',
        'unknown_error',
        data,
      );
    }

    return { transferGroupId: data };
  } catch (error) {
    throw toAppError(error, 'We could not complete that transfer.');
  }
}

/** True when a transaction is one leg of a transfer (and so is not editable). */
export function isTransferLeg(transaction: Transaction): boolean {
  return transaction.transfer_group_id !== null;
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Income / expense / net for one month.
 *
 * Aggregated by the `get_monthly_summary` SQL function so the device never
 * downloads a month of rows just to add them up. Pass `walletId: null` for an
 * across-all-wallets total.
 */
export async function getMonthlySummary(input: {
  walletId?: string | null;
  month?: DateInput;
} = {}): Promise<MonthlySummary> {
  const walletId = input.walletId ? assertUuid(input.walletId, 'walletId') : null;
  const monthDate = input.month ?? new Date();
  const month = toISODate(monthDate).slice(0, 7); // 'YYYY-MM'
  const monthStart = toMonthStart(monthDate);

  try {
    const { data, error } = await getSupabase().rpc('get_monthly_summary', {
      p_wallet_id: walletId,
      p_month: monthStart,
    });

    if (error) throw toAppError(error, 'We could not build your monthly summary.');

    const row = data?.[0];
    return {
      month,
      walletId,
      income: toNumber(row?.income),
      expense: toNumber(row?.expense),
      net: toNumber(row?.net),
      transactionCount: toNumber(row?.transaction_count),
      transferVolume: toNumber(row?.transfer_volume),
    };
  } catch (error) {
    throw toAppError(error, 'We could not build your monthly summary.');
  }
}

/**
 * Per-category totals for a month, largest first.
 * Computed client-side from the month's rows — a single indexed range scan.
 */
export async function getCategoryBreakdown(input: {
  walletId?: string | null;
  month?: DateInput;
  type?: TransactionType;
} = {}): Promise<CategoryBreakdownEntry[]> {
  const monthDate = input.month ?? new Date();
  const from = toMonthStart(monthDate);
  const to = new Date(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)),
    0,
    23,
    59,
    59,
    999,
  );

  const rows = await getTransactionsInRange(from, to, input.walletId ?? null);

  const buckets = new Map<string, { total: number; count: number }>();
  let grandTotal = 0;

  for (const row of rows) {
    if (input.type && row.type !== input.type) continue;
    // Transfers are not spending, so they would distort a category breakdown.
    if (row.transfer_group_id !== null) continue;
    const entry = buckets.get(row.category);
    if (entry) {
      entry.total += row.amount;
      entry.count += 1;
    } else {
      buckets.set(row.category, { total: row.amount, count: 1 });
    }
    grandTotal += row.amount;
  }

  return Array.from(buckets.entries())
    .map(([category, value]) => ({
      category,
      total: Math.round(value.total * 100) / 100,
      count: value.count,
      share: grandTotal > 0 ? value.total / grandTotal : 0,
    }))
    .sort((a, b) => b.total - a.total);
}
