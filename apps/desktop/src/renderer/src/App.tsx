/**
 * Desktop application root.
 *
 * Mirrors the mobile shell exactly: `useAuth` gates the UI, `useWallets` and
 * `useTransactions` own the data, and the screens stay presentational. The
 * only desktop-specific concerns here are the window chrome and the native
 * app version pulled over IPC.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createLedgerControls,
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
  Transaction,
  UpdateDebtInput,
  UpdateWalletInput,
  Wallet,
} from '@wallet/shared';

import {
  AddTransactionDialog,
  type SheetSubmission,
} from './components/AddTransactionDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DebtDialog, type DebtDraft } from './components/DebtDialog';
import { SettleDebtDialog } from './components/SettleDebtDialog';
import { IconMoon, IconSignOut, IconSun } from './components/Icons';
import { WindowControls } from './components/WindowControls';
import { AuthScreen } from './screens/AuthScreen';
import { DashboardScreen, type MainView } from './screens/DashboardScreen';
import { applyTheme, readStoredTheme, storeTheme, type ThemeMode } from './theme';

/**
 * A destructive action waiting on confirmation. The text is built when the
 * dialog is opened, so the render path stays free of branching copy.
 */
interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  action: () => Promise<void>;
}

/**
 * A bare drag handle for the states that have no top bar.
 *
 * The window is frameless (`frame: false` — see `src/main/index.ts`), so
 * before sign-in there would otherwise be nothing to drag the window by and
 * nothing to close it with. `position: fixed`, so it costs the centred
 * layouts below it no space.
 */
function FramelessHandle() {
  return (
    <div className="titlebar-strip">
      <WindowControls />
    </div>
  );
}

export default function App() {
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

  /* ── Local UI state ───────────────────────────────────────────────────── */
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  /**
   * Month, scope, search and category filters live in one object so the
   * screen can patch a single field without rebuilding the rest.
   */
  const [ledger, setLedger] = useState<LedgerControls>(() => createLedgerControls());
  const [dialogOpen, setDialogOpen] = useState(false);
  /** Non-null while the dialog is editing an existing transaction. */
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [savingTransaction, setSavingTransaction] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  /** Non-null while a destructive action is waiting on confirmation. */
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  /** Mirrors the attribute `main.tsx` already put on <html>. */
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme());

  /* ── AP/AR UI state ───────────────────────────────────────────────────── */
  const [view, setView] = useState<MainView>('ledger');
  const [debtDialogOpen, setDebtDialogOpen] = useState(false);
  /** Non-null while the debt dialog is editing an existing debt. */
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null);
  const [savingDebt, setSavingDebt] = useState(false);
  /** Non-null while a settlement is being recorded. */
  const [settlingDebt, setSettlingDebt] = useState<Debt | null>(null);
  const [savingSettlement, setSavingSettlement] = useState(false);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      storeTheme(next);
      return next;
    });
  }, []);

  const handleLedgerChange = useCallback((patch: Partial<LedgerControls>) => {
    setLedger((previous) => ({ ...previous, ...patch }));
  }, []);

  // Typing should not be one query per keystroke.
  const debouncedSearch = useDebouncedValue(ledger.search, 300);

  /* ── Native version via the preload bridge ────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    void window.desktop
      ?.getAppVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {
        // Not fatal — the top bar simply omits the version.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    limit: 100,
    includeSummary: true,
    includeBreakdown: true,
  });

  /**
   * Debts are loaded alongside the ledger rather than on first opening the
   * tab, because the tab's badge shows an overdue count — a count that is
   * only accurate if it was fetched.
   */
  const debtsState = useDebts({ enabled: isAuthenticated });

  useEffect(() => {
    if (!isAuthenticated) {
      setSelectedWalletId(null);
      setDialogOpen(false);
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
    setDialogOpen(false);
    setEditingTransaction(null);
    setPending(null);
    setSelectedWalletId(null);
    setLedger(createLedgerControls());
    setView('ledger');
    setDebtDialogOpen(false);
    setEditingDebt(null);
    setSettlingDebt(null);
    try {
      await signOut();
    } catch {
      // The hook already surfaced a message.
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
    (wallet: Wallet) => {
      setPending({
        title: `Delete “${wallet.name}”?`,
        message: `Every transaction inside it will be deleted too, and its ${wallet.currency} balance will go with it. This cannot be undone.`,
        confirmLabel: 'Delete wallet',
        action: async () => {
          await walletsState.deleteWallet(wallet.id);
          if (selectedWalletId === wallet.id) setSelectedWalletId(null);
        },
      });
    },
    [walletsState, selectedWalletId],
  );

  const handleDeleteTransaction = useCallback(
    (transaction: Transaction) => {
      const wallet = walletsState.wallets.find(
        (candidate) => candidate.id === transaction.wallet_id,
      );
      const isTransfer = transaction.transfer_group_id !== null;
      const currency = wallet ? ` ${wallet.currency}` : '';

      setPending({
        title: isTransfer ? 'Delete this transfer?' : 'Delete this transaction?',
        message: isTransfer
          ? 'Both sides will be removed and the two wallets will go back to their previous balances. This cannot be undone.'
          : `${
              transaction.type === 'INCOME' ? 'Income' : 'Expense'
            } of ${transaction.amount}${currency} under “${
              transaction.category
            }” will be removed and the wallet balance corrected. This cannot be undone.`,
        confirmLabel: isTransfer ? 'Delete transfer' : 'Delete transaction',
        action: async () => {
          await transactionsState.removeTransaction(transaction.id);
          // The balance was moved by a database trigger — re-read it.
          await walletsState.refresh();
        },
      });
    },
    [transactionsState, walletsState],
  );

  /** Runs the queued action, then closes the dialog either way. */
  const confirmPending = useCallback(async () => {
    if (!pending) return;
    setConfirmBusy(true);
    try {
      await pending.action();
    } catch {
      // The owning hook already put a message in `combinedError`.
    } finally {
      setConfirmBusy(false);
      setPending(null);
    }
  }, [pending]);

  const handleEditTransaction = useCallback((transaction: Transaction) => {
    setEditingTransaction(transaction);
    setDialogOpen(true);
  }, []);

  /* ── AP/AR actions ────────────────────────────────────────────────────── */

  const handleAddDebt = useCallback(() => {
    setEditingDebt(null);
    setDebtDialogOpen(true);
  }, []);

  const handleEditDebt = useCallback((debt: Debt) => {
    setEditingDebt(debt);
    setDebtDialogOpen(true);
  }, []);

  const handleCloseDebtDialog = useCallback(() => {
    setDebtDialogOpen(false);
    setEditingDebt(null);
  }, []);

  const handleDebtDialogSubmit = useCallback(
    async (draft: DebtDraft) => {
      setSavingDebt(true);
      try {
        if (draft.kind === 'create' && draft.create) {
          await debtsState.createDebt(draft.create as CreateDebtInput);
        } else if (draft.debtId && draft.update) {
          await debtsState.updateDebt(draft.debtId, draft.update as UpdateDebtInput);
        }
        handleCloseDebtDialog();
      } finally {
        setSavingDebt(false);
      }
    },
    [debtsState, handleCloseDebtDialog],
  );

  /**
   * Settling writes a real ledger row, so the ledger, the wallet balances and
   * the month summary all change. All three are re-read rather than guessed at.
   */
  const handleSettleDebt = useCallback(
    async (input: Parameters<typeof debtsState.settleDebt>[0]) => {
      setSavingSettlement(true);
      try {
        await debtsState.settleDebt(input);
        await Promise.all([
          walletsState.refresh(),
          transactionsState.refresh(),
        ]);
        setSettlingDebt(null);
      } finally {
        setSavingSettlement(false);
      }
    },
    [debtsState, walletsState, transactionsState],
  );

  const handleDeleteDebt = useCallback(
    (debt: Debt) => {
      const settled = debt.settled;
      setPending({
        title: `Delete the debt with ${debt.counterparty}?`,
        message:
          settled > 0
            ? `The ${debt.currency} settlements already recorded stay in your ledger and keep their effect on your balances — only the link to this debt is removed. This cannot be undone.`
            : 'The debt will be removed. No money has moved against it, so no balances change. This cannot be undone.',
        confirmLabel: 'Delete debt',
        action: async () => {
          await debtsState.deleteDebt(debt.id);
        },
      });
    },
    [debtsState],
  );

  const handleToggleDebtClosed = useCallback(
    async (debt: Debt) => {
      if (debt.closed_at !== null) {
        await debtsState.reopenDebt(debt.id);
        return;
      }
      setPending({
        title: `Close the debt with ${debt.counterparty}?`,
        message: `${debt.outstanding} ${debt.currency} is still outstanding. Closing stops it being counted as owed and refuses further settlements. It stays on the list, and you can reopen it.`,
        confirmLabel: 'Close debt',
        action: async () => {
          await debtsState.closeDebt(debt.id);
        },
      });
    },
    [debtsState],
  );

  const handleAddTransaction = useCallback(() => {
    setEditingTransaction(null);
    setDialogOpen(true);
  }, []);

  const handleCloseDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingTransaction(null);
  }, []);

  /**
   * One entry point for the dialog's three outcomes: create a transaction,
   * edit one, or move money between wallets. Each hits a different service.
   */
  const handleDialogSubmit = useCallback(
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

  const handleRefresh = useCallback(() => {
    void Promise.all([
      walletsState.refresh(),
      transactionsState.refresh(),
      debtsState.refresh(),
    ]);
  }, [walletsState, transactionsState, debtsState]);

  const combinedError = useMemo(
    () =>
      authError ??
      walletsState.error ??
      transactionsState.error ??
      debtsState.error,
    [authError, walletsState.error, transactionsState.error, debtsState.error],
  );

  /* ── Render ───────────────────────────────────────────────────────────── */

  if (status === 'loading') {
    return (
      <>
        <FramelessHandle />
        <div className="center-state">
          <span className="spinner" aria-hidden="true" />
          <span>Restoring session…</span>
        </div>
      </>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <>
        <FramelessHandle />
        <AuthScreen
          onSubmitSignIn={signIn}
          onSubmitSignUp={signUp}
          isSubmitting={isSubmitting}
          error={authError}
          onClearError={clearError}
        />
      </>
    );
  }

  const userInitial = (
    user.displayName?.trim().charAt(0) ||
    user.email?.charAt(0) ||
    '?'
  ).toUpperCase();

  /**
   * The account chip is avatar-only, so this is the only place the address
   * appears — it becomes the tooltip and the accessible name.
   */
  const accountLabel = `Signed in as ${
    user.displayName ? `${user.displayName} · ` : ''
  }${user.email ?? 'this account'}`;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="topbar-mark" aria-hidden="true">
            S
          </span>
          Sara Wallet
        </div>
        {appVersion ? <span className="topbar-version">v{appVersion}</span> : null}

        <div className="topbar-spacer" />

        <button
          type="button"
          className="icon-only"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
        </button>

        <span className="user-chip" role="img" title={accountLabel} aria-label={accountLabel}>
          <span className="user-avatar" aria-hidden="true">
            {userInitial}
          </span>
        </span>

        <button
          type="button"
          className="icon-only"
          onClick={handleSignOut}
          disabled={isSubmitting}
          title="Sign out"
          aria-label="Sign out"
        >
          <IconSignOut size={16} />
        </button>

        <WindowControls />
      </header>

      <DashboardScreen
        wallets={walletsState.wallets}
        totals={walletsState.totals}
        transactions={transactionsState.transactions}
        summary={transactionsState.summary}
        breakdown={transactionsState.breakdown}
        loading={walletsState.loading || transactionsState.loading}
        error={combinedError}
        ledger={ledger}
        onLedgerChange={handleLedgerChange}
        hasMore={transactionsState.hasMore}
        isLoadingMore={transactionsState.isLoadingMore}
        onLoadMore={transactionsState.loadMore}
        selectedWalletId={selectedWalletId}
        onSelectWallet={setSelectedWalletId}
        onRefresh={handleRefresh}
        onDeleteTransaction={handleDeleteTransaction}
        onEditTransaction={handleEditTransaction}
        onCreateWallet={handleCreateWallet}
        onUpdateWallet={handleUpdateWallet}
        onDeleteWallet={handleDeleteWallet}
        onAddTransaction={handleAddTransaction}
        view={view}
        onViewChange={setView}
        debts={debtsState.debts}
        debtTotals={debtsState.totals}
        debtsLoading={debtsState.loading}
        openDebtCount={debtsState.openDebts.length}
        overdueDebtCount={debtsState.overdueDebts.length}
        onAddDebt={handleAddDebt}
        onSettleDebt={setSettlingDebt}
        onEditDebt={handleEditDebt}
        onDeleteDebt={handleDeleteDebt}
        onToggleDebtClosed={(debt) => void handleToggleDebtClosed(debt)}
      />

      <AddTransactionDialog
        open={dialogOpen}
        wallets={walletsState.wallets}
        defaultWalletId={selectedWalletId}
        editing={editingTransaction}
        submitting={savingTransaction}
        onClose={handleCloseDialog}
        onSubmit={handleDialogSubmit}
      />

      <DebtDialog
        open={debtDialogOpen}
        editing={editingDebt}
        defaultCurrency={walletsState.wallets[0]?.currency ?? 'MMK'}
        submitting={savingDebt}
        onClose={handleCloseDebtDialog}
        onSubmit={handleDebtDialogSubmit}
      />

      <SettleDebtDialog
        open={settlingDebt !== null}
        debt={settlingDebt}
        wallets={walletsState.wallets}
        submitting={savingSettlement}
        onClose={() => setSettlingDebt(null)}
        onSubmit={handleSettleDebt}
      />

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ''}
        message={pending?.message ?? ''}
        confirmLabel={pending?.confirmLabel ?? 'Delete'}
        busy={confirmBusy}
        onConfirm={() => void confirmPending()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
