/**
 * Sara Wallet — Expo application root.
 *
 * Responsibilities, in order:
 *   1. configure the shared Supabase client (side-effect import, must be first)
 *   2. initialise the auth listener and gate the UI on the session
 *   3. own the data for both screens so they stay stateless
 *
 * Screens are presentational: they receive everything through props, which is
 * what makes the same components reusable by the Electron renderer later on.
 *
 * Two screens sit behind a tab strip — the ledger and the AP/AR view — and the
 * top bar is rendered once here rather than by each of them, so the two cannot
 * drift apart.
 */

import './src/config/supabase';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import {
  createLedgerControls,
  formatCurrency,
  useAuth,
  useDebouncedValue,
  useDebts,
  useTransactions,
  useWallets,
} from '@wallet/shared';
import type {
  CreateDebtInput,
  CreateWalletInput,
  Debt,
  LedgerControls,
  SettleDebtInput,
  Transaction,
  UpdateDebtInput,
  UpdateWalletInput,
  Wallet,
} from '@wallet/shared';

import {
  AddTransactionSheet,
  type SheetSubmission,
} from './src/components/AddTransactionSheet';
import { AppTopBar } from './src/components/AppTopBar';
import { DebtSheet } from './src/components/DebtSheet';
import { directionLabel } from './src/components/DebtRow';
import { SettleDebtSheet } from './src/components/SettleDebtSheet';
import { TabStrip, type TabOption } from './src/components/TabStrip';
import { AuthScreen } from './src/screens/AuthScreen';
import { DebtsScreen } from './src/screens/DebtsScreen';
import { WalletDashboardScreen } from './src/screens/WalletDashboardScreen';
import { colors, fontSize, fontWeight, spacing } from './src/theme';

type Tab = 'ledger' | 'debts';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <AppShell />
    </SafeAreaProvider>
  );
}

function AppShell() {
  /* ── Auth ─────────────────────────────────────────────────────────────── */
  const {
    user,
    status,
    error: authError,
    isSubmitting,
    signIn,
    signUp,
    signOut,
    clearError,
  } = useAuth();

  const isAuthenticated = status === 'authenticated';

  /* ── Navigation ───────────────────────────────────────────────────────── */
  const [tab, setTab] = useState<Tab>('ledger');

  /* ── Dashboard filters ────────────────────────────────────────────────── */
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  /**
   * Month, scope, search and category filters live in one object so the
   * screen can patch a single field without rebuilding the rest.
   */
  const [ledger, setLedger] = useState<LedgerControls>(() => createLedgerControls());
  const [sheetVisible, setSheetVisible] = useState(false);
  /** Non-null while the sheet is editing an existing transaction. */
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [savingTransaction, setSavingTransaction] = useState(false);

  /* ── Debt sheets ──────────────────────────────────────────────────────── */
  const [debtSheetVisible, setDebtSheetVisible] = useState(false);
  /** Non-null while the debt sheet is editing an existing debt. */
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null);
  /** Non-null while the settle sheet is open for that debt. */
  const [settlingDebt, setSettlingDebt] = useState<Debt | null>(null);
  const [savingDebt, setSavingDebt] = useState(false);

  const handleLedgerChange = useCallback((patch: Partial<LedgerControls>) => {
    setLedger((previous) => ({ ...previous, ...patch }));
  }, []);

  // Typing should not be one query per keystroke.
  const debouncedSearch = useDebouncedValue(ledger.search, 300);

  /* ── Data ─────────────────────────────────────────────────────────────── */
  const walletsState = useWallets({ enabled: isAuthenticated, orderBy: 'created_at' });

  const transactionsState = useTransactions({
    enabled: isAuthenticated,
    walletId: selectedWalletId,
    month: ledger.month,
    scope: ledger.scope,
    search: debouncedSearch,
    type: ledger.type,
    category: ledger.category,
    limit: 50,
    includeSummary: true,
    includeBreakdown: true,
  });

  const debtsState = useDebts({ enabled: isAuthenticated });

  // Drop a stale selection when the wallet is deleted elsewhere.
  useEffect(() => {
    if (!isAuthenticated) {
      setSelectedWalletId(null);
      return;
    }
    if (selectedWalletId && !walletsState.loading && walletsState.wallets.length > 0) {
      const stillExists = walletsState.wallets.some(
        (wallet) => wallet.id === selectedWalletId,
      );
      if (!stillExists) setSelectedWalletId(null);
    }
  }, [isAuthenticated, selectedWalletId, walletsState.wallets, walletsState.loading]);

  /* ── Actions ──────────────────────────────────────────────────────────── */
  const handleSignOut = useCallback(async () => {
    setSheetVisible(false);
    setEditingTransaction(null);
    setSelectedWalletId(null);
    setLedger(createLedgerControls());
    setDebtSheetVisible(false);
    setEditingDebt(null);
    setSettlingDebt(null);
    setTab('ledger');
    try {
      await signOut();
    } catch {
      // The hook has already surfaced a message; staying signed in is fine.
    }
  }, [signOut]);

  const handleCreateWallet = useCallback(
    async (input: CreateWalletInput) => {
      await walletsState.createWallet(input);
    },
    [walletsState],
  );

  const handleUpdateWallet = useCallback(
    async (walletId: string, patch: UpdateWalletInput) => {
      await walletsState.updateWallet(walletId, patch);
    },
    [walletsState],
  );

  const handleDeleteWallet = useCallback(
    async (wallet: Wallet) => {
      try {
        await walletsState.deleteWallet(wallet.id);
        if (selectedWalletId === wallet.id) setSelectedWalletId(null);
      } catch {
        // Surfaced through the hook's `error`.
      }
    },
    [walletsState, selectedWalletId],
  );

  const handleDeleteTransaction = useCallback(
    async (transaction: Transaction) => {
      try {
        await transactionsState.removeTransaction(transaction.id);
        // The trigger moved the balance — pull the fresh figure.
        await walletsState.refresh();
      } catch {
        // Surfaced through the hook's `error`.
      }
    },
    [transactionsState, walletsState],
  );

  const handleEditTransaction = useCallback((transaction: Transaction) => {
    setEditingTransaction(transaction);
    setSheetVisible(true);
  }, []);

  const handleAddPress = useCallback(() => {
    setEditingTransaction(null);
    setSheetVisible(true);
  }, []);

  const handleCloseSheet = useCallback(() => {
    setSheetVisible(false);
    setEditingTransaction(null);
  }, []);

  /**
   * One entry point for the sheet's three outcomes: create a transaction,
   * edit one, or move money between wallets. Each hits a different service.
   */
  const handleSheetSubmit = useCallback(
    async (submission: SheetSubmission) => {
      setSavingTransaction(true);
      try {
        if (submission.kind === 'transfer') {
          await transactionsState.transfer({
            fromWalletId: submission.fromWalletId,
            toWalletId: submission.toWalletId,
            amount: submission.amount,
            note: submission.note,
            date: submission.date,
          });
        } else if (editingTransaction) {
          await transactionsState.updateTransaction(editingTransaction.id, {
            walletId: submission.walletId,
            type: submission.type,
            amount: submission.amount,
            category: submission.category,
            note: submission.note,
            date: submission.date,
          });
        } else {
          await transactionsState.addTransaction(submission);
        }

        // Balances are maintained by a database trigger, so re-read them
        // rather than guessing locally.
        await walletsState.refresh();
      } finally {
        setSavingTransaction(false);
      }
    },
    [transactionsState, walletsState, editingTransaction],
  );

  /* ── Debts ────────────────────────────────────────────────────────────── */

  const handleAddDebt = useCallback(() => {
    setEditingDebt(null);
    setDebtSheetVisible(true);
  }, []);

  const handleEditDebt = useCallback((debt: Debt) => {
    setEditingDebt(debt);
    setDebtSheetVisible(true);
  }, []);

  const handleCloseDebtSheet = useCallback(() => {
    setDebtSheetVisible(false);
    setEditingDebt(null);
  }, []);

  const handleCreateDebt = useCallback(
    async (input: CreateDebtInput) => {
      setSavingDebt(true);
      try {
        await debtsState.createDebt(input);
      } finally {
        setSavingDebt(false);
      }
    },
    [debtsState],
  );

  const handleUpdateDebt = useCallback(
    async (debtId: string, patch: UpdateDebtInput) => {
      setSavingDebt(true);
      try {
        await debtsState.updateDebt(debtId, patch);
      } finally {
        setSavingDebt(false);
      }
    },
    [debtsState],
  );

  /**
   * The only debt action that moves money.
   *
   * A settlement is written as an ordinary transaction, so the wallet balance
   * moves through the normal trigger and the row appears in the ledger. Both
   * therefore have to be re-read — the hook refreshes the debts, but it has no
   * idea the ledger changed underneath it.
   */
  const handleSettleDebt = useCallback(
    async (input: SettleDebtInput) => {
      setSavingDebt(true);
      try {
        await debtsState.settleDebt(input);
        await Promise.all([walletsState.refresh(), transactionsState.refresh()]);
      } finally {
        setSavingDebt(false);
      }
    },
    [debtsState, walletsState, transactionsState],
  );

  const handleDeleteDebt = useCallback(
    (debt: Debt) => {
      Alert.alert(
        `Delete the debt with ${debt.counterparty}?`,
        'Any settlements stay in your ledger — only the link is removed, so no wallet balance changes.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              void debtsState.deleteDebt(debt.id);
            },
          },
        ],
      );
    },
    [debtsState],
  );

  /**
   * Closes an unpaid debt, or reopens a closed one.
   *
   * Closing is not the same as settling: nothing moves, it just stops being
   * counted as owed and refuses further settlements. That is why it asks first
   * even though it is not destructive in the ledger.
   */
  const handleToggleDebtClosed = useCallback(
    (debt: Debt) => {
      if (debt.closed_at !== null) {
        void debtsState.reopenDebt(debt.id);
        return;
      }

      Alert.alert(
        `Close the debt with ${debt.counterparty}?`,
        `${formatCurrency(debt.outstanding, debt.currency)} is still outstanding. Closing stops it being counted as owed and refuses further settlements. It stays on the list, and you can reopen it.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Close debt',
            style: 'destructive',
            onPress: () => {
              void debtsState.closeDebt(debt.id);
            },
          },
        ],
      );
    },
    [debtsState],
  );

  /**
   * The long-press menu. Android's `Alert` renders at most three buttons, so
   * editing is on tap and only the destructive three live here.
   */
  const handleDebtActions = useCallback(
    (debt: Debt) => {
      const closed = debt.closed_at !== null;
      const settled = !closed && debt.outstanding <= 0;

      Alert.alert(
        debt.counterparty,
        `${directionLabel(debt)} · ${formatCurrency(debt.outstanding, debt.currency)} outstanding`,
        [
          {
            text: closed ? 'Reopen debt' : settled ? 'Stop counting it' : 'Close — written off',
            onPress: () => handleToggleDebtClosed(debt),
          },
          { text: 'Delete', style: 'destructive', onPress: () => handleDeleteDebt(debt) },
          { text: 'Cancel', style: 'cancel' },
        ],
      );
    },
    [handleToggleDebtClosed, handleDeleteDebt],
  );

  const handleSettlePress = useCallback((debt: Debt) => setSettlingDebt(debt), []);

  const handleCloseSettleSheet = useCallback(() => setSettlingDebt(null), []);

  /* ── Refresh ──────────────────────────────────────────────────────────── */

  const handleLedgerRefresh = useCallback(async () => {
    await Promise.all([walletsState.refresh(), transactionsState.refresh()]);
  }, [walletsState, transactionsState]);

  // Debts pull the wallets too: a settlement may have moved a balance since.
  const handleDebtsRefresh = useCallback(async () => {
    await Promise.all([debtsState.refresh(), walletsState.refresh()]);
  }, [debtsState, walletsState]);

  const ledgerError = useMemo(
    () => authError ?? walletsState.error ?? transactionsState.error,
    [authError, walletsState.error, transactionsState.error],
  );

  const tabs = useMemo<TabOption<Tab>[]>(
    () => [
      { value: 'ledger', label: 'Ledger' },
      {
        value: 'debts',
        label: 'Debts',
        count: debtsState.openDebts.length,
        // Only overdue counts are painted red — it is the one genuinely urgent
        // state, and it is a "late" red rather than an income red.
        countAlarming: debtsState.overdueDebts.length > 0,
      },
    ],
    [debtsState.openDebts.length, debtsState.overdueDebts.length],
  );

  /* ── Render ───────────────────────────────────────────────────────────── */

  if (status === 'loading') {
    return (
      <SafeAreaView style={styles.splash} edges={['top', 'bottom']}>
        <View style={styles.splashLogo}>
          <Text style={styles.splashGlyph}>₿</Text>
        </View>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.splashText}>Sara Wallet</Text>
      </SafeAreaView>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <AuthScreen
          onSubmitSignIn={signIn}
          onSubmitSignUp={signUp}
          isSubmitting={isSubmitting}
          error={authError}
          onClearError={clearError}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <AppTopBar user={user} onSignOut={handleSignOut} />

      <TabStrip tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'ledger' ? (
        <WalletDashboardScreen
          wallets={walletsState.wallets}
          totals={walletsState.totals}
          transactions={transactionsState.transactions}
          summary={transactionsState.summary}
          breakdown={transactionsState.breakdown}
          loading={walletsState.loading || transactionsState.loading}
          refreshing={walletsState.refreshing || transactionsState.refreshing}
          error={ledgerError}
          ledger={ledger}
          onLedgerChange={handleLedgerChange}
          hasMore={transactionsState.hasMore}
          isLoadingMore={transactionsState.isLoadingMore}
          onLoadMore={transactionsState.loadMore}
          selectedWalletId={selectedWalletId}
          onSelectWallet={setSelectedWalletId}
          onRefresh={handleLedgerRefresh}
          onDeleteTransaction={handleDeleteTransaction}
          onEditTransaction={handleEditTransaction}
          onCreateWallet={handleCreateWallet}
          onUpdateWallet={handleUpdateWallet}
          onDeleteWallet={handleDeleteWallet}
          onAddTransactionPress={handleAddPress}
        />
      ) : (
        <DebtsScreen
          debts={debtsState.debts}
          totals={debtsState.totals}
          wallets={walletsState.wallets}
          loading={debtsState.loading}
          refreshing={debtsState.refreshing}
          error={debtsState.error}
          onRefresh={handleDebtsRefresh}
          onAddDebt={handleAddDebt}
          onSettle={handleSettlePress}
          onEdit={handleEditDebt}
          onOpenActions={handleDebtActions}
        />
      )}

      <AddTransactionSheet
        visible={sheetVisible}
        wallets={walletsState.wallets}
        defaultWalletId={selectedWalletId}
        editing={editingTransaction}
        submitting={savingTransaction}
        onClose={handleCloseSheet}
        onSubmit={handleSheetSubmit}
      />

      <DebtSheet
        visible={debtSheetVisible}
        editing={editingDebt}
        defaultCurrency={walletsState.wallets[0]?.currency ?? 'MMK'}
        submitting={savingDebt}
        onClose={handleCloseDebtSheet}
        onCreate={handleCreateDebt}
        onUpdate={handleUpdateDebt}
      />

      <SettleDebtSheet
        visible={settlingDebt !== null}
        debt={settlingDebt}
        wallets={walletsState.wallets}
        submitting={savingDebt}
        onClose={handleCloseSettleSheet}
        onSubmit={handleSettleDebt}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    gap: spacing.lg,
  },
  splashLogo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashGlyph: {
    fontSize: 36,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
  },
  splashText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
});
