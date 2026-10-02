/**
 * Wallet domain types + DTOs.
 *
 * The `Row` types come straight from the database definition; everything else
 * is either a validated input DTO or a view-model the UI can render directly.
 */

import type { TransactionType, WalletRow } from './database';

/** A wallet exactly as it is stored. */
export type Wallet = WalletRow;

/** Currency codes the UI offers out of the box. Any ISO-4217 code is accepted. */
export const SUPPORTED_CURRENCIES = [
  'MMK',
  'THB',
  'USD',
  'SGD',
  'MYR',
  'EUR',
  'GBP',
  'CNY',
  'JPY',
  'INR',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/** An ISO-4217 code. Typed loosely on purpose: the DB validates the format. */
export type CurrencyCode = string;

/* -------------------------------------------------------------------------- */
/* Input DTOs                                                                  */
/* -------------------------------------------------------------------------- */

export interface CreateWalletInput {
  name: string;
  /** Defaults to `MMK` on the server. */
  currency?: CurrencyCode;
  /**
   * Money the wallet already holds before any transaction is recorded.
   * Stored directly on insert — the ledger trigger only applies deltas.
   */
  openingBalance?: number;
}

export interface UpdateWalletInput {
  name?: string;
  currency?: CurrencyCode;
}

export interface ListWalletsOptions {
  /** `'name'` is the default. */
  orderBy?: 'name' | 'balance' | 'created_at';
  ascending?: boolean;
}

/* -------------------------------------------------------------------------- */
/* View models                                                                 */
/* -------------------------------------------------------------------------- */

export interface WalletTotals {
  /** Sum of every wallet balance, ignoring currency mismatches. */
  totalBalance: number;
  walletCount: number;
  /** Grouped so a user holding MMK and THB is not shown a nonsense single sum. */
  byCurrency: Array<{
    currency: CurrencyCode;
    balance: number;
    walletCount: number;
  }>;
}

export interface WalletWithActivity extends Wallet {
  transactionCount: number;
  lastActivityAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Guards / normalisers                                                        */
/* -------------------------------------------------------------------------- */

/** PostgREST has historically returned `numeric` as either number or string. */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Coerces a raw row into a fully numeric `Wallet`. */
export function normaliseWallet(row: WalletRow): Wallet {
  return { ...row, balance: toNumber(row.balance) };
}

export function isTransactionType(value: unknown): value is TransactionType {
  return value === 'INCOME' || value === 'EXPENSE';
}
