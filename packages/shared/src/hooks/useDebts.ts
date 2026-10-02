/**
 * `useDebts` — the AP/AR panel's state.
 *
 * Mirrors `useWallets`: every mutation re-reads from the server rather than
 * patching local state. A debt's `settled` and `outstanding` are computed by
 * the `debt_balances` view from the settlement rows, so a local increment would
 * be a second, silently diverging copy of arithmetic the database already
 * owns — and settling a debt also moves a wallet balance, which only the server
 * knows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  closeDebt as closeDebtService,
  createDebt as createDebtService,
  deleteDebt as deleteDebtService,
  getDebts,
  getDebtTotals,
  reopenDebt as reopenDebtService,
  settleDebt as settleDebtService,
  updateDebt as updateDebtService,
} from '../services/debt';
import type { Transaction } from '../services/transaction';
import type {
  CreateDebtInput,
  Debt,
  DebtStatus,
  DebtTotals,
  ListDebtsOptions,
  SettleDebtInput,
  UpdateDebtInput,
} from '../types/debt';
import { debtStatus, isOverdue } from '../types/debt';
import { describeError } from '../utils/errors';

export interface UseDebtsOptions {
  /** Skip loading entirely (e.g. while the user is signed out). */
  enabled?: boolean;
  /** Hide settled and closed debts. Off by default: history is useful. */
  openOnly?: boolean;
  orderBy?: ListDebtsOptions['orderBy'];
  ascending?: boolean;
}

export interface UseDebtsResult {
  debts: Debt[];
  /** Open, partly-unsettled debts — what the summary tiles describe. */
  openDebts: Debt[];
  /** Overdue subset, already sorted most-urgent-first. */
  overdueDebts: Debt[];
  totals: DebtTotals;
  /** `true` only for the very first load. */
  loading: boolean;
  /** `true` for background revalidation. */
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createDebt: (input: CreateDebtInput) => Promise<Debt>;
  updateDebt: (debtId: string, patch: UpdateDebtInput) => Promise<Debt>;
  deleteDebt: (debtId: string) => Promise<void>;
  closeDebt: (debtId: string) => Promise<Debt>;
  reopenDebt: (debtId: string) => Promise<Debt>;
  /**
   * Records a settlement. Resolves to the ledger row that was written — it is
   * an ordinary transaction, so the caller may need its id to navigate to it.
   */
  settleDebt: (input: SettleDebtInput) => Promise<Transaction>;
  getDebtById: (debtId: string) => Debt | undefined;
  statusOf: (debt: Debt) => DebtStatus;
  clearError: () => void;
}

const EMPTY_TOTALS: DebtTotals = { byCurrency: [], openCount: 0 };

export function useDebts(options: UseDebtsOptions = {}): UseDebtsResult {
  const { enabled = true, openOnly = false, orderBy = 'due_on', ascending = true } = options;

  const [debts, setDebts] = useState<Debt[]>([]);
  const [totals, setTotals] = useState<DebtTotals>(EMPTY_TOTALS);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (mode: 'initial' | 'revalidate' = 'revalidate') => {
      if (!enabled) {
        setDebts([]);
        setTotals(EMPTY_TOTALS);
        setLoading(false);
        return;
      }

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const [nextDebts, nextTotals] = await Promise.all([
          getDebts({ orderBy, ascending, openOnly }),
          getDebtTotals(),
        ]);

        if (!mountedRef.current) return;
        setDebts(nextDebts);
        setTotals(nextTotals);
        setError(null);
        hasLoadedRef.current = true;
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [enabled, orderBy, ascending, openOnly],
  );

  useEffect(() => {
    if (!enabled) {
      setDebts([]);
      setTotals(EMPTY_TOTALS);
      setLoading(false);
      return;
    }
    void refresh(hasLoadedRef.current ? 'revalidate' : 'initial');
  }, [enabled, refresh]);

  /** Wraps a mutation so every one of them refreshes and reports alike. */
  const mutate = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      try {
        const result = await run();
        await refresh();
        return result;
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const createDebt = useCallback(
    (input: CreateDebtInput) => mutate(() => createDebtService(input)),
    [mutate],
  );

  const updateDebt = useCallback(
    (debtId: string, patch: UpdateDebtInput) => mutate(() => updateDebtService(debtId, patch)),
    [mutate],
  );

  const deleteDebt = useCallback(
    async (debtId: string): Promise<void> => {
      await mutate(() => deleteDebtService(debtId));
    },
    [mutate],
  );

  const closeDebt = useCallback(
    (debtId: string) => mutate(() => closeDebtService(debtId)),
    [mutate],
  );

  const reopenDebt = useCallback(
    (debtId: string) => mutate(() => reopenDebtService(debtId)),
    [mutate],
  );

  const settleDebt = useCallback(
    (input: SettleDebtInput) => mutate(() => settleDebtService(input)),
    [mutate],
  );

  const debtsById = useMemo(() => new Map(debts.map((debt) => [debt.id, debt])), [debts]);

  const getDebtById = useCallback((debtId: string) => debtsById.get(debtId), [debtsById]);

  /**
   * Derived slices. `openOnly` is applied locally as well as in the query so
   * these stay correct when the caller asked for the full history — the summary
   * tiles must not include a written-off debt just because the list does.
   */
  const openDebts = useMemo(
    () => debts.filter((debt) => debt.closed_at === null && debt.outstanding > 0),
    [debts],
  );

  const overdueDebts = useMemo(() => openDebts.filter((debt) => isOverdue(debt)), [openDebts]);

  const statusOf = useCallback((debt: Debt) => debtStatus(debt), []);

  const clearError = useCallback(() => setError(null), []);

  return {
    debts,
    openDebts,
    overdueDebts,
    totals,
    loading,
    refreshing,
    error,
    refresh: useCallback(() => refresh('revalidate'), [refresh]),
    createDebt,
    updateDebt,
    deleteDebt,
    closeDebt,
    reopenDebt,
    settleDebt,
    getDebtById,
    statusOf,
    clearError,
  };
}
