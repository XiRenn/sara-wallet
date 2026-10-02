/**
 * Wallet service — direct Supabase table access, scoped by RLS.
 *
 * No `user_id` is ever trusted from the caller for reads: Row Level Security
 * already filters every query to `auth.uid()`. For writes the id is stamped
 * from the live session so a malicious payload cannot claim another owner.
 */

import { getSupabase } from '../config/supabase';
import type { WalletRow, WalletUpdate } from '../types/database';
import {
  normaliseWallet,
  toNumber,
  type CreateWalletInput,
  type ListWalletsOptions,
  type UpdateWalletInput,
  type Wallet,
  type WalletTotals,
} from '../types/wallet';
import { AppError, toAppError, unwrap } from '../utils/errors';
import {
  assertCurrencyCode,
  assertNonEmptyString,
  assertNonNegativeAmount,
  assertUuid,
} from '../utils/validate';
import { requireUserId } from './auth';

const TABLE = 'wallets' as const;

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every wallet owned by the signed-in user.
 * RLS makes the `user_id` filter redundant, but keeping it makes the generated
 * SQL obviously correct in logs and lets the composite index do its job.
 */
export async function getWallets(options: ListWalletsOptions = {}): Promise<Wallet[]> {
  const { orderBy = 'name', ascending = true } = options;
  const userId = await requireUserId();

  try {
    const { data, error } = await getSupabase()
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .order(orderBy, { ascending });

    if (error) throw toAppError(error, 'We could not load your wallets.');

    return (data ?? []).map(normaliseWallet);
  } catch (error) {
    throw toAppError(error, 'We could not load your wallets.');
  }
}

/** A single wallet, or `null` when it does not exist / is not yours. */
export async function getWalletById(walletId: string): Promise<Wallet | null> {
  const id = assertUuid(walletId, 'walletId');

  try {
    const { data, error } = await getSupabase()
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw toAppError(error, 'We could not load that wallet.');
    return data ? normaliseWallet(data) : null;
  } catch (error) {
    throw toAppError(error, 'We could not load that wallet.');
  }
}

/** Totals for the dashboard header. */
export async function getWalletTotals(): Promise<WalletTotals> {
  const wallets = await getWallets({ orderBy: 'created_at', ascending: true });

  const grouped = new Map<string, { balance: number; walletCount: number }>();
  let totalBalance = 0;

  for (const wallet of wallets) {
    const balance = toNumber(wallet.balance);
    totalBalance += balance;

    const entry = grouped.get(wallet.currency);
    if (entry) {
      entry.balance += balance;
      entry.walletCount += 1;
    } else {
      grouped.set(wallet.currency, { balance, walletCount: 1 });
    }
  }

  return {
    totalBalance,
    walletCount: wallets.length,
    byCurrency: Array.from(grouped.entries())
      .map(([currency, value]) => ({ currency, ...value }))
      .sort((a, b) => b.balance - a.balance),
  };
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Creates a wallet.
 *
 * `openingBalance` is written straight into the `balance` column on insert —
 * the ledger trigger only ever applies deltas to existing rows, so this does
 * not double-count.
 */
export async function createWallet(input: CreateWalletInput): Promise<Wallet> {
  const name = assertNonEmptyString(input.name, 'name', 80);
  const currency = input.currency
    ? assertCurrencyCode(input.currency)
    : 'MMK';
  const openingBalance =
    input.openingBalance === undefined
      ? 0
      : assertNonNegativeAmount(input.openingBalance, 'openingBalance');

  const userId = await requireUserId();

  try {
    const result = await getSupabase()
      .from(TABLE)
      .insert({
        user_id: userId,
        name,
        currency,
        balance: openingBalance,
      })
      .select('*')
      .single();

    return normaliseWallet(unwrap(result, 'We could not create that wallet.'));
  } catch (error) {
    throw toAppError(error, 'We could not create that wallet.');
  }
}

/**
 * Renames a wallet or changes its currency.
 *
 * `balance` is intentionally NOT updatable here: it is derived from the
 * ledger by `tg_transactions_apply_balance`. Adjust it by recording an
 * INCOME/EXPENSE transaction instead — otherwise the balance and the
 * transaction history will silently disagree.
 */
export async function updateWallet(
  walletId: string,
  patch: UpdateWalletInput,
): Promise<Wallet> {
  const id = assertUuid(walletId, 'walletId');

  const payload: WalletUpdate = {};
  if (patch.name !== undefined) {
    payload.name = assertNonEmptyString(patch.name, 'name', 80);
  }
  if (patch.currency !== undefined) {
    payload.currency = assertCurrencyCode(patch.currency);
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

    return normaliseWallet(unwrap(result, 'We could not update that wallet.'));
  } catch (error) {
    throw toAppError(error, 'We could not update that wallet.');
  }
}

/**
 * Deletes a wallet **and every transaction inside it** (ON DELETE CASCADE).
 * Returns the number of wallets actually removed (0 or 1).
 */
export async function deleteWallet(walletId: string): Promise<number> {
  const id = assertUuid(walletId, 'walletId');

  try {
    const { data, error } = await getSupabase()
      .from(TABLE)
      .delete()
      .eq('id', id)
      .select('id');

    if (error) throw toAppError(error, 'We could not delete that wallet.');
    return data?.length ?? 0;
  } catch (error) {
    throw toAppError(error, 'We could not delete that wallet.');
  }
}

/** Raw row access, for callers that need the untouched database shape. */
export async function getWalletRow(walletId: string): Promise<WalletRow | null> {
  const id = assertUuid(walletId, 'walletId');
  const { data, error } = await getSupabase()
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw toAppError(error, 'We could not load that wallet.');
  return data ?? null;
}
