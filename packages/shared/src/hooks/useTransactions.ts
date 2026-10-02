/**
 * `useTransactions` — paged activity feed + monthly summary + category breakdown.
 *
 * Pass `walletId: null` for an across-all-wallets view, or a specific id to
 * scope everything to one wallet.
 *
 * The list pages. It used to fetch a fixed 50 rows and stop, which meant a
 * user with more than 50 transactions simply could not see the older ones and
 * was never told so. `loadMore()` appends the next page and `hasMore` says
 * whether there is one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addTransaction as addTransactionService,
  deleteTransaction as deleteTransactionService,
  getCategoryBreakdown,
  getMonthlySummary,
  getTransactionsPage,
  MAX_PAGE_SIZE,
  transferBetweenWallets as transferBetweenWalletsService,
  updateTransaction as updateTransactionService,
  type AddTransactionInput,
  type CategoryBreakdownEntry,
  type MonthlySummary,
  type Transaction,
  type TransferInput,
  type TransferResult,
  type UpdateTransactionInput,
} from '../services/transaction';
import type { TransactionType } from '../types/database';
import type { LedgerScope } from '../types/ledger';
import { endOfMonth, toISODate, toMonthKey, toMonthStart } from '../utils/date';
import { describeError } from '../utils/errors';

export const DEFAULT_LEDGER_PAGE_SIZE = 50;

export interface UseTransactionsOptions {
  /** `null` (default) = every wallet. */
  walletId?: string | null;
  /** Which month the summary/breakdown cover. Defaults to the current month. */
  month?: Date;
  /**
   * Which rows the list covers. `'month'` (default) follows `month`;
   * `'all'` drops the date bounds and pages through everything.
   */
  scope?: LedgerScope;
  /** Rows per page. Clamped to `MAX_PAGE_SIZE`. */
  limit?: number;
  /** Free text matched against note and category. */
  search?: string;
  type?: TransactionType | null;
  category?: string | null;
  /** Skip loading (e.g. while signed out). */
  enabled?: boolean;
  /** Set to `false` to skip the extra aggregation round trip. */
  includeSummary?: boolean;
  includeBreakdown?: boolean;
}

export interface UseTransactionsResult {
  transactions: Transaction[];
  summary: MonthlySummary | null;
  breakdown: CategoryBreakdownEntry[];
  loading: boolean;
  refreshing: boolean;
  /** True while the *next* page is in flight — not the first one. */
  isLoadingMore: boolean;
  /** Whether another page exists behind the current one. */
  hasMore: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Appends the next page. A no-op when loading, exhausted, or disabled. */
  loadMore: () => Promise<void>;
  addTransaction: (input: Omit<AddTransactionInput, 'walletId'> & { walletId?: string }) => Promise<Transaction>;
  updateTransaction: (
    transactionId: string,
    patch: UpdateTransactionInput,
  ) => Promise<Transaction>;
  /**
   * Moves money between two wallets. Writes both ledger legs in one database
   * transaction, then refreshes the list.
   */
  transfer: (input: TransferInput) => Promise<TransferResult>;
  removeTransaction: (transactionId: string) => Promise<void>;
  clearError: () => void;
}

/**
 * Appends a page, dropping rows that are already on screen.
 *
 * Offset paging can hand the same row back twice: if a write lands between
 * page 1 and page 2, everything shifts by one and the last row of page 1
 * reappears at the top of page 2. React would then render two children with
 * the same `key` and warn. The `id` check turns that into a non-event.
 */
export function mergeTransactionPages(
  existing: readonly Transaction[],
  incoming: readonly Transaction[],
): Transaction[] {
  const seen = new Set(existing.map((row) => row.id));
  return [...existing, ...incoming.filter((row) => !seen.has(row.id))];
}

export function useTransactions(
  options: UseTransactionsOptions = {},
): UseTransactionsResult {
  const {
    walletId = null,
    month,
    scope = 'month',
    limit = DEFAULT_LEDGER_PAGE_SIZE,
    search,
    type = null,
    category = null,
    enabled = true,
    includeSummary = true,
    includeBreakdown = false,
  } = options;

  // A stable primitive key — `Date` objects are new on every render and would
  // otherwise re-trigger the effect in a loop.
  const monthKey = useMemo(() => toMonthKey(month ?? new Date()), [month]);
  const searchTerm = (search ?? '').trim();
  const pageSize = Math.min(
    Math.max(1, Math.trunc(limit) || DEFAULT_LEDGER_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<MonthlySummary | null>(null);
  const [breakdown, setBreakdown] = useState<CategoryBreakdownEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);
  /**
   * Bumped on every fresh load. A page that comes back after the filters have
   * changed carries an older id and is dropped instead of being merged into a
   * list it does not belong to.
   */
  const requestIdRef = useRef(0);
  /** The rows currently on screen, so `loadMore` can compute its offset. */
  const rowsRef = useRef<Transaction[]>([]);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    (offset: number) => {
      const monthDate = new Date(`${monthKey}-01T00:00:00`);
      return getTransactionsPage({
        walletId,
        limit: pageSize,
        offset,
        search: searchTerm.length > 0 ? searchTerm : undefined,
        type: type ?? undefined,
        category: category ?? undefined,
        from: scope === 'month' ? toMonthStart(monthDate) : undefined,
        to: scope === 'month' ? toISODate(endOfMonth(monthDate)) : undefined,
      });
    },
    [walletId, pageSize, searchTerm, type, category, scope, monthKey],
  );

  const refresh = useCallback(
    async (mode: 'initial' | 'revalidate' = 'revalidate') => {
      if (!enabled) {
        requestIdRef.current += 1;
        rowsRef.current = [];
        hasMoreRef.current = false;
        setTransactions([]);
        setSummary(null);
        setBreakdown([]);
        setHasMore(false);
        setIsLoadingMore(false);
        setLoading(false);
        return;
      }

      const requestId = (requestIdRef.current += 1);
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      const monthDate = new Date(`${monthKey}-01T00:00:00`);

      try {
        const [page, nextSummary, nextBreakdown] = await Promise.all([
          fetchPage(0),
          includeSummary
            ? getMonthlySummary({ walletId, month: monthDate })
            : Promise.resolve(null),
          includeBreakdown
            ? getCategoryBreakdown({ walletId, month: monthDate })
            : Promise.resolve<CategoryBreakdownEntry[]>([]),
        ]);

        if (!mountedRef.current || requestId !== requestIdRef.current) return;

        rowsRef.current = page.rows;
        hasMoreRef.current = page.hasMore;
        setTransactions(page.rows);
        setHasMore(page.hasMore);
        setSummary(nextSummary);
        setBreakdown(nextBreakdown);
        setError(null);
        hasLoadedRef.current = true;
      } catch (cause) {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setError(describeError(cause));
        }
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [enabled, fetchPage, monthKey, walletId, includeSummary, includeBreakdown],
  );

  useEffect(() => {
    if (!enabled) {
      requestIdRef.current += 1;
      rowsRef.current = [];
      hasMoreRef.current = false;
      setTransactions([]);
      setSummary(null);
      setBreakdown([]);
      setHasMore(false);
      setIsLoadingMore(false);
      setLoading(false);
      return;
    }
    void refresh(hasLoadedRef.current ? 'revalidate' : 'initial');
  }, [enabled, refresh]);

  const loadMore = useCallback(async () => {
    if (!enabled || loadingMoreRef.current || !hasMoreRef.current) return;

    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    // Deliberately *not* bumping `requestIdRef`: a filter change is what
    // invalidates this page, and it bumps the id itself.
    const requestId = requestIdRef.current;

    try {
      const page = await fetchPage(rowsRef.current.length);
      if (!mountedRef.current || requestId !== requestIdRef.current) return;

      const merged = mergeTransactionPages(rowsRef.current, page.rows);
      rowsRef.current = merged;
      hasMoreRef.current = page.hasMore;
      setTransactions(merged);
      setHasMore(page.hasMore);
      setError(null);
    } catch (cause) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(describeError(cause));
      }
    } finally {
      loadingMoreRef.current = false;
      if (mountedRef.current) setIsLoadingMore(false);
    }
  }, [enabled, fetchPage]);

  const addTransaction = useCallback(
    async (
      input: Omit<AddTransactionInput, 'walletId'> & { walletId?: string },
    ): Promise<Transaction> => {
      const targetWalletId = input.walletId ?? walletId;
      if (!targetWalletId) {
        throw new Error('addTransaction requires a walletId.');
      }

      try {
        const created = await addTransactionService({
          ...input,
          walletId: targetWalletId,
        });
        await refresh();
        return created;
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh, walletId],
  );

  const updateTransaction = useCallback(
    async (
      transactionId: string,
      patch: UpdateTransactionInput,
    ): Promise<Transaction> => {
      try {
        const updated = await updateTransactionService(transactionId, patch);
        await refresh();
        return updated;
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const transfer = useCallback(
    async (input: TransferInput): Promise<TransferResult> => {
      try {
        const result = await transferBetweenWalletsService(input);
        await refresh();
        return result;
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const removeTransaction = useCallback(
    async (transactionId: string): Promise<void> => {
      try {
        await deleteTransactionService(transactionId);
        await refresh();
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    transactions,
    summary,
    breakdown,
    loading,
    refreshing,
    isLoadingMore,
    hasMore,
    error,
    refresh: useCallback(() => refresh('revalidate'), [refresh]),
    loadMore,
    addTransaction,
    updateTransaction,
    transfer,
    removeTransaction,
    clearError,
  };
}
