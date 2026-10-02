/**
 * The category vocabulary.
 *
 * These two arrays used to be copy-pasted into the mobile sheet and the
 * desktop dialog. Two copies of the same list is exactly how a picker on one
 * platform ends up offering a category the other one cannot filter by, so they
 * live here now, next to the ledger types they describe.
 *
 * `category` is a free-text column in PostgreSQL — nothing in the schema
 * constrains it. These lists are the *suggestions* both pickers render; a row
 * created by the transfer RPC or by an older client can legitimately carry a
 * category that is not in them.
 */

import type { TransactionType } from './database';

export const INCOME_CATEGORIES = [
  'Salary',
  'Freelance',
  'Business',
  'Gift',
  'Interest',
  'Refund',
  'Debt collection',
  'Other',
] as const;

export const EXPENSE_CATEGORIES = [
  'Food',
  'Transport',
  'Bills',
  'Shopping',
  'Health',
  'Education',
  'Rent',
  'Debt payment',
  'Other',
] as const;

/**
 * Written by `transfer_between_wallets` on both legs. Never offered in the
 * picker: a transfer is created through the transfer flow, not by choosing a
 * category.
 */
export const TRANSFER_CATEGORY = 'Transfer';

/**
 * Defaults applied when a settlement is recorded from the debt flow rather
 * than from the transaction form. They are ordinary categories — a user may
 * re-categorise a settlement afterwards without breaking anything, because the
 * link that matters is `transactions.debt_id`, not the category string.
 */
export const DEBT_COLLECTION_CATEGORY = 'Debt collection';
export const DEBT_PAYMENT_CATEGORY = 'Debt payment';

export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type Category = IncomeCategory | ExpenseCategory | typeof TRANSFER_CATEGORY;

/** Every category either picker can produce, plus `Transfer`, deduped. */
export const ALL_CATEGORIES: readonly string[] = Array.from(
  new Set<string>([...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES, TRANSFER_CATEGORY]),
).sort((a, b) => a.localeCompare(b));

/** The suggestions a picker should show for a given direction. */
export function categoriesForType(type: TransactionType): readonly string[] {
  return type === 'INCOME' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}
