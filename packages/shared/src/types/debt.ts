/**
 * Accounts Payable / Accounts Receivable — domain types, DTOs and the pure
 * predicates the UI sorts and colours by.
 *
 * ## The one idea this file encodes
 *
 * A debt is an **obligation**, not a cash movement. Recording one writes no
 * ledger row and moves no wallet balance. **Settling** one *is* a cash
 * movement: it writes an ordinary `transactions` row, which the balance trigger
 * applies exactly as it would for any other income or expense, and links it
 * back through `transactions.debt_id`.
 *
 * That is why there is no `settlements` table. A settlement *is* a transaction;
 * a second table would be a second copy of the same truth, free to disagree
 * with the ledger. And it is why `outstanding` is derived —
 * `principal - sum(settlements)` — rather than stored: a stored balance is one
 * more thing that can drift from the rows it summarises. The database computes
 * it in the `debt_balances` view.
 *
 * ## Direction
 *
 * `RECEIVABLE` — somebody owes **you**. Settled by an `INCOME`; the money comes
 * back into a wallet.
 *
 * `PAYABLE` — **you** owe somebody. Settled by an `EXPENSE`; the money leaves a
 * wallet.
 *
 * The pairing is not a convention the client may choose: the
 * `tg_transactions_validate_debt_link` trigger refuses a mismatched row,
 * because posting an INCOME against a payable would invent money out of a debt
 * you still owe.
 */

import type {
  DebtBalanceRow,
  DebtDirection,
  DebtInsert,
  DebtRow,
  DebtUpdate,
  TransactionType,
} from './database';
import { toNumber } from './wallet';
import type { CurrencyCode } from './wallet';
import { toDateBound, toISODate, type DateInput } from '../utils/date';
/** A debt as the UI renders it: stored columns plus the derived money. */
export type Debt = DebtBalanceRow;

/** A debt without its settlement roll-up — the raw table row. */
export type StoredDebt = DebtRow;

export const DEBT_DIRECTIONS: readonly DebtDirection[] = ['RECEIVABLE', 'PAYABLE'] as const;

export function isDebtDirection(value: unknown): value is DebtDirection {
  return value === 'RECEIVABLE' || value === 'PAYABLE';
}

/* -------------------------------------------------------------------------- */
/* Direction <-> ledger type                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The ledger row type that settles a debt in this direction.
 *
 * Mirrors the trigger in `0005_debts.sql`. If this ever disagrees with the
 * database the insert is refused with `23514`, so the pairing is enforced in
 * exactly one place and this is a reflection of it, not a second rule.
 */
export function settlementTypeFor(direction: DebtDirection): TransactionType {
  return direction === 'RECEIVABLE' ? 'INCOME' : 'EXPENSE';
}

/** The category a settlement is filed under when the flow picks one for you. */
export function defaultSettlementCategory(direction: DebtDirection): string {
  return direction === 'RECEIVABLE' ? 'Debt collection' : 'Debt payment';
}

/** Which direction a given ledger row would settle. Inverse of the above. */
export function directionForSettlementType(type: TransactionType): DebtDirection {
  return type === 'INCOME' ? 'RECEIVABLE' : 'PAYABLE';
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a debt sits right now.
 *
 * `SETTLED` and `CLOSED` are different things and the UI must not merge them:
 * a debt settled in full still exists as a record of who paid what, whereas
 * `CLOSED` means the user gave up on it — written off, forgiven, or settled
 * outside the app. Both stop accepting settlements, for different reasons.
 */
export type DebtStatus = 'OPEN' | 'DUE_SOON' | 'OVERDUE' | 'SETTLED' | 'CLOSED';

/** A debt is "due soon" inside this many days of its due date. */
export const DUE_SOON_DAYS = 7;

export interface DebtStatusInput {
  closed_at: string | null;
  due_on: string | null;
  outstanding: number;
}

/**
 * Status is derived from three facts and nothing else, so it can never be
 * stale: a row cannot be marked overdue while its `due_on` says otherwise.
 *
 * A null `due_on` means "no agreed date", which is not the same as "due now" —
 * such a debt is never overdue.
 */
export function debtStatus(debt: DebtStatusInput, today: DateInput = new Date()): DebtStatus {
  if (debt.closed_at !== null) return 'CLOSED';
  if (toNumber(debt.outstanding) <= 0) return 'SETTLED';
  if (debt.due_on === null) return 'OPEN';

  const days = daysUntilDue(debt.due_on, today);
  if (days === null) return 'OPEN';
  if (days < 0) return 'OVERDUE';
  if (days <= DUE_SOON_DAYS) return 'DUE_SOON';
  return 'OPEN';
}

/** Negative when the due date has passed. Null when there is no due date. */
export function daysUntilDue(dueOn: string | null, today: DateInput = new Date()): number | null {
  if (dueOn === null) return null;

  // Both sides are reduced to local midnight before subtracting. Comparing a
  // date-only string against `new Date()` directly would make the answer depend
  // on the time of day: at 09:00 a debt due today reads as "today", at 23:00 it
  // still does, but only because the difference never crosses a boundary —
  // subtracting raw instants gives 0.37 days, which floors to 0 by luck.
  const due = startOfDayUTC(dueOn);
  const now = startOfDayUTC(toISODate(today));
  if (due === null || now === null) return null;

  return Math.round((due - now) / 86_400_000);
}

/** Parses `YYYY-MM-DD` to a UTC midnight timestamp, avoiding local-time drift. */
function startOfDayUTC(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** True when the debt is open, has a due date, and that date has passed. */
export function isOverdue(debt: DebtStatusInput, today: DateInput = new Date()): boolean {
  return debtStatus(debt, today) === 'OVERDUE';
}

/** 0–1, clamped. A fully settled debt is 1; an untouched one is 0. */
export function debtProgress(debt: Pick<Debt, 'principal' | 'settled'>): number {
  const principal = toNumber(debt.principal);
  if (principal <= 0) return 0;
  const settled = toNumber(debt.settled);
  return Math.min(1, Math.max(0, settled / principal));
}

/* -------------------------------------------------------------------------- */
/* Input DTOs                                                                  */
/* -------------------------------------------------------------------------- */

export interface CreateDebtInput {
  direction: DebtDirection;
  /** Free text — a person, a shop, an institution. 1–80 chars. */
  counterparty: string;
  principal: number;
  /** Defaults to `MMK` on the server. */
  currency?: CurrencyCode;
  note?: string | null;
  issuedOn?: DateInput;
  /**
   * Omit for "no agreed date". The database enforces `due_on >= issued_on`,
   * so a back-dated due date needs a matching `issuedOn`.
   */
  dueOn?: DateInput | null;
}

/**
 * What may change after the fact.
 *
 * `principal`, `currency` and `direction` are absent on purpose: once money has
 * been settled against a debt, changing any of the three would silently
 * reinterpret settlements that already moved real money. The
 * `tg_debts_guard_edits` trigger refuses them, so offering them here would be
 * offering an action that cannot succeed. To correct one, delete the debt and
 * record a new one.
 */
export interface UpdateDebtInput {
  counterparty?: string;
  note?: string | null;
  dueOn?: DateInput | null;
  /** Set to close a debt without settling it — written off or forgiven. */
  closedAt?: string | null;
}

export interface SettleDebtInput {
  debtId: string;
  /** Must hold the debt's currency; the trigger refuses a mismatch. */
  walletId: string;
  amount: number;
  date?: DateInput;
  note?: string;
  /** Defaults to `defaultSettlementCategory(direction)`. */
  category?: string;
}

export interface ListDebtsOptions {
  /** `'due_on'` is the default — soonest first, undated last. */
  orderBy?: 'due_on' | 'issued_on' | 'counterparty' | 'outstanding';
  ascending?: boolean;
  /** When true, settled and closed debts are omitted. */
  openOnly?: boolean;
  direction?: DebtDirection | null;
  currency?: CurrencyCode | null;
}

/* -------------------------------------------------------------------------- */
/* View models                                                                 */
/* -------------------------------------------------------------------------- */

/** One currency's AP/AR position. */
export interface DebtTotalsByCurrency {
  currency: CurrencyCode;
  receivableOutstanding: number;
  payableOutstanding: number;
  receivableOverdue: number;
  payableOverdue: number;
  openCount: number;
}

/**
 * Grouped by currency for the same reason `WalletTotals` is: adding MMK to THB
 * produces a number that means nothing. `net` is only meaningful *within* a
 * currency — what you are owed less what you owe, in that currency.
 */
export interface DebtTotals {
  byCurrency: DebtTotalsByCurrency[];
  /** Every currency combined — for the "has any debt at all" empty state. */
  openCount: number;
}

export interface DebtWithActivity extends Debt {
  /** Settlements posted against this debt, newest first. */
  settlements?: Array<{
    id: string;
    amount: number;
    date: string;
    note: string | null;
    walletId: string;
  }>;
}

/* -------------------------------------------------------------------------- */
/* Normalisers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * PostgREST has historically returned `numeric` as either number or string, and
 * a view's `sum()` is no more trustworthy than a column's. Every money field on
 * a debt goes through `toNumber()` on the way in.
 */
export function normaliseDebt(row: DebtBalanceRow): Debt {
  return {
    ...row,
    principal: toNumber(row.principal),
    settled: toNumber(row.settled),
    outstanding: toNumber(row.outstanding),
  };
}

export function normaliseDebts(rows: readonly DebtBalanceRow[]): Debt[] {
  return rows.map(normaliseDebt);
}

/* -------------------------------------------------------------------------- */
/* Sorting                                                                     */
/* -------------------------------------------------------------------------- */

const STATUS_ORDER: Record<DebtStatus, number> = {
  OVERDUE: 0,
  DUE_SOON: 1,
  OPEN: 2,
  SETTLED: 3,
  CLOSED: 4,
};

/**
 * Most-urgent-first. Overdue beats due-soon beats open; inside a status,
 * undated debts sort last rather than first — `null` would otherwise be coerced
 * to 0 and read as "due in 1970".
 */
export function compareDebts(a: Debt, b: Debt, today: DateInput = new Date()): number {
  const byStatus = STATUS_ORDER[debtStatus(a, today)] - STATUS_ORDER[debtStatus(b, today)];
  if (byStatus !== 0) return byStatus;

  if (a.due_on === null && b.due_on !== null) return 1;
  if (a.due_on !== null && b.due_on === null) return -1;
  if (a.due_on !== null && b.due_on !== null && a.due_on !== b.due_on) {
    return a.due_on < b.due_on ? -1 : 1;
  }

  return a.counterparty.localeCompare(b.counterparty);
}

/* -------------------------------------------------------------------------- */
/* Database payload builders                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Builds the INSERT payload. Split out from the service so the date handling is
 * testable without a database — `due_on` is a `date` column, and handing it a
 * full ISO instant would let the server pick which calendar day it lands on.
 */
export function toDebtInsert(input: CreateDebtInput, userId: string): DebtInsert {
  return {
    user_id: userId,
    direction: input.direction,
    counterparty: input.counterparty.trim(),
    currency: input.currency,
    principal: input.principal,
    note: input.note?.trim() ? input.note.trim() : null,
    issued_on: input.issuedOn === undefined ? undefined : toDateBound(input.issuedOn, 'issuedOn'),
    due_on: input.dueOn === undefined || input.dueOn === null ? null : toDateBound(input.dueOn, 'dueOn'),
  };
}

export function toDebtUpdate(input: UpdateDebtInput): DebtUpdate {
  const patch: DebtUpdate = {};

  if (input.counterparty !== undefined) patch.counterparty = input.counterparty.trim();
  if (input.note !== undefined) patch.note = input.note?.trim() ? input.note.trim() : null;
  if (input.dueOn !== undefined) {
    patch.due_on = input.dueOn === null ? null : toDateBound(input.dueOn, 'dueOn');
  }
  if (input.closedAt !== undefined) patch.closed_at = input.closedAt;

  return patch;
}
