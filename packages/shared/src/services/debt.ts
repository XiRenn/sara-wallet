/**
 * Accounts Payable / Receivable service.
 *
 * ## What this layer does and does not do
 *
 * It never computes money that the database already computes. `settled` and
 * `outstanding` come from the `debt_balances` view; totals come from the
 * `get_debt_totals()` RPC. Re-deriving either here would create a second
 * implementation free to disagree with the one the database enforces.
 *
 * It also never writes `wallets.balance`. A settlement is an ordinary
 * transaction, so it is written through `addTransaction()` and the balance
 * trigger does the rest — the same rule as everywhere else in this codebase.
 *
 * ## Why the client checks what the database already checks
 *
 * The trigger in `0005_debts.sql` is the authority on whether a settlement is
 * legal. The checks here exist only to turn a SQLSTATE into a sentence, and
 * they are deliberately *weaker* than the trigger: anything the database would
 * accept, this layer accepts too. A divergence would show up as a refusal the
 * user cannot act on.
 */

import { getSupabase } from '../config/supabase';
import type { DebtUpdate } from '../types/database';
import {
  compareDebts,
  defaultSettlementCategory,
  normaliseDebt,
  normaliseDebts,
  settlementTypeFor,
  toDebtInsert,
  toDebtUpdate,
  type CreateDebtInput,
  type Debt,
  type DebtTotals,
  type DebtTotalsByCurrency,
  type ListDebtsOptions,
  type SettleDebtInput,
  type UpdateDebtInput,
} from '../types/debt';
import { toNumber } from '../types/wallet';
import { AppError, toAppError, unwrap } from '../utils/errors';
import { toDateBound } from '../utils/date';
import {
  assertCurrencyCode,
  assertNonEmptyString,
  assertOptionalString,
  assertPositiveAmount,
  assertUuid,
} from '../utils/validate';
import { requireUserId } from './auth';
import { addTransaction, getTransactionsPage, type Transaction } from './transaction';

const TABLE = 'debts' as const;
const VIEW = 'debt_balances' as const;

/**
 * Money is `numeric(18,2)`, so two amounts that should be equal can differ by a
 * float epsilon. Comparisons that decide whether an action is *allowed* use
 * this tolerance so a fully-settled debt is not refused a final payment of
 * 0.0000001.
 */
const MONEY_EPSILON = 0.005;

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every debt the signed-in user has, most urgent first.
 *
 * The database orders by currency; the urgency order is applied here because
 * it depends on *today* and on the derived status — overdue before due-soon
 * before open. Pushing that into SQL would mean a `case` expression that has to
 * be kept in step with `debtStatus()` in `types/debt.ts`, which is the kind of
 * duplication that drifts.
 */
export async function getDebts(options: ListDebtsOptions = {}): Promise<Debt[]> {
  const userId = await requireUserId();

  try {
    let request = getSupabase().from(VIEW).select('*').eq('user_id', userId);

    if (options.openOnly) {
      // `outstanding > 0` rather than `settled < principal`: the view already
      // derives it, and re-deriving would let a rounding difference drop a
      // debt with one cent left on it out of the list.
      request = request.is('closed_at', null).gt('outstanding', 0);
    }
    if (options.direction) request = request.eq('direction', options.direction);
    if (options.currency) request = request.eq('currency', assertCurrencyCode(options.currency));

    const { data, error } = await request;
    if (error) throw toAppError(error, 'We could not load your debts.');

    return sortDebts(normaliseDebts(data ?? []), options);
  } catch (error) {
    throw toAppError(error, 'We could not load your debts.');
  }
}

/** Open debts only — the common case for the AP/AR panel. */
export function getOpenDebts(options: Omit<ListDebtsOptions, 'openOnly'> = {}): Promise<Debt[]> {
  return getDebts({ ...options, openOnly: true });
}

/** A single debt with its derived balances, or `null` when it is not yours. */
export async function getDebtById(debtId: string): Promise<Debt | null> {
  const id = assertUuid(debtId, 'debtId');

  try {
    const { data, error } = await getSupabase()
      .from(VIEW)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw toAppError(error, 'We could not load that debt.');
    return data ? normaliseDebt(data) : null;
  } catch (error) {
    throw toAppError(error, 'We could not load that debt.');
  }
}

/**
 * Per-currency AP/AR totals, straight from `get_debt_totals()`.
 *
 * Grouped by currency for the same reason wallet totals are: adding MMK to THB
 * produces a number that means nothing. `net` is therefore only meaningful
 * inside a currency.
 */
export async function getDebtTotals(): Promise<DebtTotals> {
  try {
    const { data, error } = await getSupabase().rpc('get_debt_totals');
    if (error) throw toAppError(error, 'We could not load your debt totals.');

    const byCurrency: DebtTotalsByCurrency[] = (data ?? []).map((row) => ({
      currency: row.currency,
      receivableOutstanding: toNumber(row.receivable_outstanding),
      payableOutstanding: toNumber(row.payable_outstanding),
      receivableOverdue: toNumber(row.receivable_overdue),
      payableOverdue: toNumber(row.payable_overdue),
      openCount: toNumber(row.open_count),
    }));

    return {
      byCurrency,
      openCount: byCurrency.reduce((total, entry) => total + entry.openCount, 0),
    };
  } catch (error) {
    throw toAppError(error, 'We could not load your debt totals.');
  }
}

/**
 * The ledger rows that settle one debt.
 *
 * Goes through `getTransactionsPage` rather than building its own query: the
 * paging, the total sort order and the `user_id` scoping are decided in exactly
 * one place, and a second query builder is how the silent-50-row cap happened.
 */
export async function getDebtSettlements(
  debtId: string,
  limit = 100,
): Promise<Transaction[]> {
  const id = assertUuid(debtId, 'debtId');
  const { rows } = await getTransactionsPage({ debtId: id, limit, ascending: false });
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Records an obligation. **Writes no ledger row and moves no balance** — a debt
 * is a promise, and the money only moves when it is settled.
 *
 * The created row is read back from the view rather than reconstructed from the
 * insert payload, so the caller renders what the database actually holds
 * instead of what this function believed it sent.
 */
export async function createDebt(input: CreateDebtInput): Promise<Debt> {
  if (input.direction !== 'RECEIVABLE' && input.direction !== 'PAYABLE') {
    throw new AppError(
      '`direction` must be either RECEIVABLE or PAYABLE.',
      'validation_error',
      input.direction,
    );
  }

  const counterparty = assertNonEmptyString(input.counterparty, 'counterparty', 80);
  const principal = assertPositiveAmount(input.principal, 'principal');
  const currency = input.currency ? assertCurrencyCode(input.currency) : undefined;
  const note = assertOptionalString(input.note ?? undefined, 'note', 500) ?? null;

  // A due date with no issue date is resolved against *today on this device*.
  // The column default is the server's `current_date`, which is a different
  // calendar day for a Yangon user between 18:30 and midnight — and it would
  // make the cross-field check below disagree with the constraint it mirrors.
  const issuedOn = input.issuedOn ?? new Date();

  const payload = toDebtInsert(
    { ...input, counterparty, principal, currency, note, issuedOn },
    await requireUserId(),
  );

  if (payload.due_on && payload.due_on < toDateBound(issuedOn, 'issuedOn')) {
    throw new AppError(
      'A due date cannot fall before the date the debt was recorded.',
      'validation_error',
    );
  }

  try {
    const result = await getSupabase().from(TABLE).insert(payload).select('id').single();
    const { id } = unwrap(result, 'We could not record that debt.');

    const debt = await getDebtById(id);
    if (debt === null) throw new AppError('We could not record that debt.', 'not_found');
    return debt;
  } catch (error) {
    throw toAppError(error, 'We could not record that debt.');
  }
}

/**
 * Edits a debt's descriptive fields.
 *
 * `principal`, `currency` and `direction` are not reachable from here — see
 * `UpdateDebtInput`. Once money has been settled against a debt, changing any
 * of the three would silently reinterpret payments that already moved real
 * cash, and `tg_debts_guard_edits` refuses it. Correcting one means deleting
 * the debt and recording a new one.
 */
export async function updateDebt(debtId: string, patch: UpdateDebtInput): Promise<Debt> {
  const id = assertUuid(debtId, 'debtId');

  const payload: DebtUpdate = toDebtUpdate({
    ...patch,
    counterparty:
      patch.counterparty === undefined
        ? undefined
        : assertNonEmptyString(patch.counterparty, 'counterparty', 80),
    note:
      patch.note === undefined
        ? undefined
        : assertOptionalString(patch.note ?? undefined, 'note', 500) ?? null,
  });

  if (Object.keys(payload).length === 0) {
    throw new AppError('Nothing to update.', 'validation_error');
  }

  try {
    const result = await getSupabase()
      .from(TABLE)
      .update(payload)
      .eq('id', id)
      .select('id')
      .single();
    unwrap(result, 'We could not update that debt.');

    const debt = await getDebtById(id);
    if (debt === null) throw new AppError('We could not update that debt.', 'not_found');
    return debt;
  } catch (error) {
    throw toAppError(error, 'We could not update that debt.');
  }
}

/**
 * Closes a debt without settling it — written off, forgiven, or paid outside
 * the app.
 *
 * Distinct from reaching `outstanding = 0`: a settled debt still records who
 * paid what, whereas closing says "stop counting this". Both refuse further
 * settlements, which the trigger enforces for closed debts and the overpayment
 * check enforces for settled ones.
 */
export async function closeDebt(debtId: string): Promise<Debt> {
  return updateDebt(debtId, { closedAt: new Date().toISOString() });
}

/** Reopens a closed debt so it can be settled again. */
export async function reopenDebt(debtId: string): Promise<Debt> {
  return updateDebt(debtId, { closedAt: null });
}

/**
 * Deletes a debt.
 *
 * Its settlements are **not** deleted: `transactions.debt_id` is
 * `on delete set null`, so the money stays on the ledger with its link severed.
 * Erasing the rows would change wallet balances retroactively — a user who
 * deleted a debt would watch their balance drop for no visible reason.
 */
export async function deleteDebt(debtId: string): Promise<number> {
  const id = assertUuid(debtId, 'debtId');

  try {
    const { data, error } = await getSupabase().from(TABLE).delete().eq('id', id).select('id');
    if (error) throw toAppError(error, 'We could not delete that debt.');
    return data?.length ?? 0;
  } catch (error) {
    throw toAppError(error, 'We could not delete that debt.');
  }
}

/**
 * Settles (part of) a debt with a real ledger row.
 *
 * The row is written by `addTransaction()` so a settlement is an ordinary
 * transaction everywhere else in the app — it appears in the ledger, counts
 * toward the month's income or expense, and moves the wallet balance through
 * the same trigger. The only thing that makes it a settlement is `debt_id`.
 */
export async function settleDebt(input: SettleDebtInput): Promise<Transaction> {
  const debtId = assertUuid(input.debtId, 'debtId');
  const walletId = assertUuid(input.walletId, 'walletId');
  const amount = assertPositiveAmount(input.amount, 'amount');

  // Read the debt first: it decides the ledger type, the currency and whether
  // the payment is even possible, and a refusal here costs no write.
  const debt = await getDebtById(debtId);
  if (debt === null) {
    throw new AppError('That debt no longer exists.', 'not_found', debtId);
  }

  if (debt.closed_at !== null) {
    throw new AppError('That debt is already closed.', 'validation_error', debtId);
  }

  if (amount - toNumber(debt.outstanding) > MONEY_EPSILON) {
    throw new AppError(
      `That is more than is still outstanding (${toNumber(debt.outstanding)}).`,
      'validation_error',
      { amount, outstanding: toNumber(debt.outstanding) },
    );
  }

  return addTransaction({
    walletId,
    type: settlementTypeFor(debt.direction),
    amount,
    category: input.category ?? defaultSettlementCategory(debt.direction),
    note: input.note ?? null,
    date: input.date,
    debtId,
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Applies the caller's requested order, defaulting to urgency.
 *
 * `orderBy` is honoured as a primary key and `compareDebts` breaks ties, so
 * asking for "by counterparty" still puts an overdue debt above a settled one
 * of the same name.
 */
function sortDebts(debts: Debt[], options: ListDebtsOptions): Debt[] {
  const ascending = options.ascending ?? true;
  const direction = ascending ? 1 : -1;

  const comparators: Record<
    NonNullable<ListDebtsOptions['orderBy']>,
    (a: Debt, b: Debt) => number
  > = {
    due_on: (a, b) => compareNullableDate(a.due_on, b.due_on),
    issued_on: (a, b) => compareNullableDate(a.issued_on, b.issued_on),
    counterparty: (a, b) => a.counterparty.localeCompare(b.counterparty),
    outstanding: (a, b) => toNumber(a.outstanding) - toNumber(b.outstanding),
  };

  const primary = comparators[options.orderBy ?? 'due_on'];

  return [...debts].sort((a, b) => {
    const byRequested = primary(a, b);
    if (byRequested !== 0) return byRequested * direction;
    return compareDebts(a, b);
  });
}

/** `null` sorts last in both directions — "no due date" is not "due in 1970". */
function compareNullableDate(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
