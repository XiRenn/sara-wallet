/**
 * What the ledger list is currently showing.
 *
 * Both apps keep this in one state object and hand it to `useTransactions`,
 * so the mobile and desktop filter bars cannot drift apart — a filter added
 * on one platform is a prop on the other, not a second implementation.
 */

import type { TransactionType } from './database';
import { startOfMonth } from '../utils/date';

/**
 * Which rows the list covers.
 *
 * `'month'` follows the selected month — the same month the summary tiles and
 * the category breakdown describe. `'all'` drops the date bounds entirely and
 * pages through the whole ledger.
 */
export type LedgerScope = 'month' | 'all';

export interface LedgerControls {
  /** The month the summary, breakdown and (when `scope` is `'month'`) the list cover. */
  month: Date;
  scope: LedgerScope;
  /** Free text matched against `note` and `category`. */
  search: string;
  type: TransactionType | null;
  category: string | null;
}

export function createLedgerControls(now: Date = new Date()): LedgerControls {
  return {
    month: startOfMonth(now),
    scope: 'month',
    search: '',
    type: null,
    category: null,
  };
}

/**
 * True when the user has narrowed the list beyond "this month, everything".
 * Drives the "Clear filters" affordance — which should not appear when there
 * is nothing to clear.
 *
 * Month navigation and the `'all'` scope are deliberately excluded: those are
 * *where* you are looking, not *what* you are filtering for, and clearing them
 * would move the user somewhere they did not ask to go.
 */
export function hasLedgerFilters(controls: LedgerControls): boolean {
  return (
    controls.search.trim().length > 0 ||
    controls.type !== null ||
    controls.category !== null
  );
}
