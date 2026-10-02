/**
 * `useWallets` — wallet list + totals, with optimistic-free CRUD helpers.
 *
 * Every mutation re-reads the list from the server. Balances are computed by a
 * database trigger, so a local guess would eventually drift from the truth.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createWallet as createWalletService,
  deleteWallet as deleteWalletService,
  getWallets,
  getWalletTotals,
  updateWallet as updateWalletService,
} from '../services/wallet';
import type {
  CreateWalletInput,
  UpdateWalletInput,
  Wallet,
  WalletTotals,
} from '../types/wallet';
import { describeError } from '../utils/errors';

export interface UseWalletsOptions {
  /** Skip loading entirely (e.g. while the user is signed out). */
  enabled?: boolean;
  orderBy?: 'name' | 'balance' | 'created_at';
  ascending?: boolean;
}

export interface UseWalletsResult {
  wallets: Wallet[];
  totals: WalletTotals;
  /** `true` only for the very first load, so the UI can show a spinner once. */
  loading: boolean;
  /** `true` for pull-to-refresh / background revalidation. */
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createWallet: (input: CreateWalletInput) => Promise<Wallet>;
  updateWallet: (walletId: string, patch: UpdateWalletInput) => Promise<Wallet>;
  deleteWallet: (walletId: string) => Promise<void>;
  getWalletById: (walletId: string) => Wallet | undefined;
  clearError: () => void;
}

const EMPTY_TOTALS: WalletTotals = {
  totalBalance: 0,
  walletCount: 0,
  byCurrency: [],
};

export function useWallets(options: UseWalletsOptions = {}): UseWalletsResult {
  const { enabled = true, orderBy = 'name', ascending = true } = options;

  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [totals, setTotals] = useState<WalletTotals>(EMPTY_TOTALS);
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
        setWallets([]);
        setTotals(EMPTY_TOTALS);
        setLoading(false);
        return;
      }

      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);

      try {
        const [nextWallets, nextTotals] = await Promise.all([
          getWallets({ orderBy, ascending }),
          getWalletTotals(),
        ]);

        if (!mountedRef.current) return;
        setWallets(nextWallets);
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
    [enabled, orderBy, ascending],
  );

  useEffect(() => {
    if (!enabled) {
      setWallets([]);
      setTotals(EMPTY_TOTALS);
      setLoading(false);
      return;
    }
    void refresh(hasLoadedRef.current ? 'revalidate' : 'initial');
  }, [enabled, refresh]);

  const createWallet = useCallback(
    async (input: CreateWalletInput): Promise<Wallet> => {
      try {
        const wallet = await createWalletService(input);
        await refresh();
        return wallet;
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const updateWallet = useCallback(
    async (walletId: string, patch: UpdateWalletInput): Promise<Wallet> => {
      try {
        const wallet = await updateWalletService(walletId, patch);
        await refresh();
        return wallet;
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const deleteWallet = useCallback(
    async (walletId: string): Promise<void> => {
      try {
        await deleteWalletService(walletId);
        await refresh();
      } catch (cause) {
        if (mountedRef.current) setError(describeError(cause));
        throw cause;
      }
    },
    [refresh],
  );

  const walletsById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, wallet])),
    [wallets],
  );

  const getWalletById = useCallback(
    (walletId: string) => walletsById.get(walletId),
    [walletsById],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    wallets,
    totals,
    loading,
    refreshing,
    error,
    refresh: useCallback(() => refresh('revalidate'), [refresh]),
    createWallet,
    updateWallet,
    deleteWallet,
    getWalletById,
    clearError,
  };
}
