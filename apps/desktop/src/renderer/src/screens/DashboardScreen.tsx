import React, { useMemo, useState } from 'react';

import {
  formatCurrency,
  formatDate,
  parseAmount,
  SUPPORTED_CURRENCIES,
  type CategoryBreakdownEntry,
  type CreateWalletInput,
  type Debt,
  type DebtTotals,
  type LedgerControls,
  type MonthlySummary,
  type Transaction,
  type UpdateWalletInput,
  type Wallet,
  type WalletTotals,
} from '@wallet/shared';

import { DebtsPanel } from '../components/DebtsPanel';
import { LedgerPanel } from '../components/LedgerPanel';
import { WalletListItem } from '../components/WalletListItem';
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconClose,
  IconHandCoins,
  IconPlus,
  IconTransfer,
  IconWallet,
} from '../components/Icons';

/**
 * Which of the two peer views the main panel is showing. The month summary
 * stays above both — it describes the month, not either list.
 */
export type MainView = 'ledger' | 'debts';

interface DashboardScreenProps {
  wallets: Wallet[];
  totals: WalletTotals;
  transactions: Transaction[];
  summary: MonthlySummary | null;
  breakdown: CategoryBreakdownEntry[];
  loading: boolean;
  error: string | null;
  /** Month / scope / search / type / category — see `LedgerControls`. */
  ledger: LedgerControls;
  onLedgerChange: (patch: Partial<LedgerControls>) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  selectedWalletId: string | null;
  onSelectWallet: (walletId: string | null) => void;
  onRefresh: () => void;
  onDeleteTransaction: (transaction: Transaction) => void;
  onEditTransaction: (transaction: Transaction) => void;
  onCreateWallet: (input: CreateWalletInput) => Promise<void>;
  onUpdateWallet: (walletId: string, patch: UpdateWalletInput) => Promise<void>;
  onDeleteWallet: (wallet: Wallet) => void;
  onAddTransaction: () => void;

  /* ── Accounts Payable / Receivable ────────────────────────────────────── */
  view: MainView;
  onViewChange: (view: MainView) => void;
  debts: Debt[];
  debtTotals: DebtTotals;
  debtsLoading: boolean;
  /** Open, partly-unsettled debts — the badge on the Debts tab. */
  openDebtCount: number;
  overdueDebtCount: number;
  onAddDebt: () => void;
  onSettleDebt: (debt: Debt) => void;
  onEditDebt: (debt: Debt) => void;
  onDeleteDebt: (debt: Debt) => void;
  onToggleDebtClosed: (debt: Debt) => void;
}

export function DashboardScreen({
  wallets,
  totals,
  transactions,
  summary,
  breakdown,
  loading,
  error,
  ledger,
  onLedgerChange,
  hasMore,
  isLoadingMore,
  onLoadMore,
  selectedWalletId,
  onSelectWallet,
  onRefresh,
  onDeleteTransaction,
  onEditTransaction,
  onCreateWallet,
  onUpdateWallet,
  onDeleteWallet,
  onAddTransaction,
  view,
  onViewChange,
  debts,
  debtTotals,
  debtsLoading,
  openDebtCount,
  overdueDebtCount,
  onAddDebt,
  onSettleDebt,
  onEditDebt,
  onDeleteDebt,
  onToggleDebtClosed,
}: DashboardScreenProps) {
  const [showWalletForm, setShowWalletForm] = useState(false);
  /** Non-null while the wallet form is editing an existing wallet. */
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null);
  const [newWalletName, setNewWalletName] = useState('');
  const [newWalletCurrency, setNewWalletCurrency] = useState('MMK');
  const [newWalletOpening, setNewWalletOpening] = useState('');
  const [walletFormError, setWalletFormError] = useState<string | null>(null);
  const [creatingWallet, setCreatingWallet] = useState(false);

  const walletsById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, wallet])),
    [wallets],
  );

  const selectedWallet = selectedWalletId
    ? (walletsById.get(selectedWalletId) ?? null)
    : null;

  const activeCurrency =
    selectedWallet?.currency ?? totals.byCurrency[0]?.currency ?? 'MMK';

  const monthLabel = formatDate(ledger.month, 'month');

  const closeWalletForm = () => {
    setShowWalletForm(false);
    setEditingWalletId(null);
    setNewWalletName('');
    setNewWalletOpening('');
    setWalletFormError(null);
  };

  const openCreateForm = () => {
    setEditingWalletId(null);
    setNewWalletName('');
    setNewWalletOpening('');
    setNewWalletCurrency('MMK');
    setWalletFormError(null);
    setShowWalletForm(true);
  };

  const openRenameForm = (wallet: Wallet) => {
    setEditingWalletId(wallet.id);
    setNewWalletName(wallet.name);
    setNewWalletCurrency(wallet.currency);
    setNewWalletOpening('');
    setWalletFormError(null);
    setShowWalletForm(true);
  };

  /** Creates a wallet, or renames the one being edited. */
  const handleWalletFormSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const name = newWalletName.trim();
    if (name.length === 0) {
      setWalletFormError('Give the wallet a name.');
      return;
    }

    // Opening balance only makes sense at creation — afterwards the balance is
    // owned by the transaction ledger.
    let openingBalance = 0;
    if (editingWalletId === null) {
      const openingText = newWalletOpening.trim();
      if (openingText.length > 0) {
        const parsed = parseAmount(openingText);
        if (parsed === null) {
          setWalletFormError('Opening balance must be a number.');
          return;
        }
        openingBalance = parsed;
      }
    }

    setWalletFormError(null);
    setCreatingWallet(true);
    try {
      if (editingWalletId) {
        await onUpdateWallet(editingWalletId, { name });
      } else {
        await onCreateWallet({ name, currency: newWalletCurrency, openingBalance });
      }
      closeWalletForm();
    } catch (cause) {
      setWalletFormError(
        cause instanceof Error ? cause.message : 'Could not save that wallet.',
      );
    } finally {
      setCreatingWallet(false);
    }
  };

  return (
    <div className="workspace">
      {/* ── Sidebar: wallets ─────────────────────────────────────────────── */}
      <aside className="card sidebar">
        <div className="panel-head">
          <div className="title-with-count">
            <h2 className="panel-title">Wallets</h2>
            {wallets.length > 0 ? (
              <span className="count-badge">{wallets.length}</span>
            ) : null}
          </div>
          <button
            type="button"
            className="link-btn"
            onClick={() => (showWalletForm ? closeWalletForm() : openCreateForm())}
          >
            {showWalletForm ? <IconClose size={14} /> : <IconPlus size={14} />}
            {showWalletForm ? 'Cancel' : 'New'}
          </button>
        </div>

        <div className="panel-body">
          {showWalletForm ? (
            <form className="wallet-form" onSubmit={handleWalletFormSubmit}>
              <p className="form-title">
                {editingWalletId ? 'Rename wallet' : 'New wallet'}
              </p>

              <input
                className="input"
                value={newWalletName}
                onChange={(event) => setNewWalletName(event.target.value)}
                placeholder="Wallet name"
                maxLength={80}
                autoFocus
              />

              {editingWalletId === null ? (
                <>
                  <input
                    className="input"
                    value={newWalletOpening}
                    onChange={(event) => setNewWalletOpening(event.target.value)}
                    placeholder="Opening balance (optional)"
                    inputMode="decimal"
                  />
                  <div className="chip-row">
                    {SUPPORTED_CURRENCIES.slice(0, 6).map((code) => (
                      <button
                        key={code}
                        type="button"
                        className="chip"
                        aria-pressed={code === newWalletCurrency}
                        onClick={() => setNewWalletCurrency(code)}
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                // Currency is fixed once a wallet exists — changing it would
                // reinterpret the stored balance. The database enforces it too.
                <p className="form-hint">
                  Currency stays {newWalletCurrency}. Create a new wallet to use a
                  different one.
                </p>
              )}

              {walletFormError ? (
                <p className="field-error" style={{ marginTop: 10 }}>
                  {walletFormError}
                </p>
              ) : null}

              <button type="submit" className="btn btn-primary" disabled={creatingWallet}>
                {creatingWallet ? (
                  <span className="spinner" aria-hidden="true" />
                ) : editingWalletId ? (
                  'Save name'
                ) : (
                  'Create wallet'
                )}
              </button>
            </form>
          ) : null}

          <button
            type="button"
            className="sidebar-total"
            aria-pressed={selectedWalletId === null}
            onClick={() => onSelectWallet(null)}
          >
            <span className="sidebar-total-label">
              <IconWallet size={13} />
              All wallets
            </span>
            <span className="sidebar-total-value">
              {formatCurrency(totals.totalBalance, activeCurrency)}
            </span>
          </button>

          {wallets.map((wallet) => (
            <WalletListItem
              key={wallet.id}
              wallet={wallet}
              selected={wallet.id === selectedWalletId}
              onSelect={onSelectWallet}
              onRename={openRenameForm}
              onDelete={onDeleteWallet}
            />
          ))}

          {!loading && wallets.length === 0 ? (
            <div className="empty-state is-compact">
              <IconWallet size={26} />
              <span>No wallets yet.</span>
              <button type="button" className="link-btn" onClick={openCreateForm}>
                <IconPlus size={14} />
                Create your first wallet
              </button>
            </div>
          ) : null}
        </div>
      </aside>

      {/* ── Main panel: balances + ledger ────────────────────────────────── */}
      <section className="card main-panel">
        <div className="summary-grid">
          <div className="summary-tile is-hero">
            <div className="summary-tile-head">
              <span className="tile-icon">
                <IconWallet size={15} />
              </span>
              <span className="summary-label">
                {selectedWallet ? `${selectedWallet.name} balance` : 'Total balance'}
              </span>
            </div>
            <div className="summary-value">
              {formatCurrency(selectedWallet?.balance ?? totals.totalBalance, activeCurrency)}
            </div>
            <div className="summary-sub">
              {selectedWallet
                ? `${selectedWallet.currency} · this wallet only`
                : `Across ${wallets.length} wallet${wallets.length === 1 ? '' : 's'}`}
            </div>
          </div>

          <div className="summary-tile is-income">
            <div className="summary-tile-head">
              <span className="tile-icon">
                <IconArrowUpRight size={15} />
              </span>
              <span className="summary-label">Money in</span>
            </div>
            <div className="summary-value">
              {formatCurrency(summary?.income ?? 0, activeCurrency)}
            </div>
            <div className="summary-sub">{monthLabel}</div>
          </div>

          <div className="summary-tile is-expense">
            <div className="summary-tile-head">
              <span className="tile-icon">
                <IconArrowDownRight size={15} />
              </span>
              <span className="summary-label">Money out</span>
            </div>
            <div className="summary-value">
              {formatCurrency(summary?.expense ?? 0, activeCurrency)}
            </div>
            <div className="summary-sub">{monthLabel}</div>
          </div>
        </div>

        {(summary?.transferVolume ?? 0) > 0 ? (
          <p className="transfer-note">
            <IconTransfer size={14} />
            {formatCurrency(summary?.transferVolume ?? 0, activeCurrency)} moved between your
            own wallets — not counted as income or spending.
          </p>
        ) : null}

        {/* Two peer views over the same account. Tabs rather than a third
            column: the workspace is already sidebar + panel, and a debt row
            needs the full width to show its progress bar. */}
        <div className="tabs" role="tablist" aria-label="Main view">
          <button
            type="button"
            role="tab"
            className="tab"
            id="tab-ledger"
            aria-selected={view === 'ledger'}
            aria-controls="panel-ledger"
            onClick={() => onViewChange('ledger')}
          >
            <IconWallet size={14} />
            Ledger
          </button>
          <button
            type="button"
            role="tab"
            className="tab"
            id="tab-debts"
            aria-selected={view === 'debts'}
            aria-controls="panel-debts"
            onClick={() => onViewChange('debts')}
          >
            <IconHandCoins size={14} />
            Debts
            {openDebtCount > 0 ? (
              <span className={`tab-count${overdueDebtCount > 0 ? ' is-alert' : ''}`}>
                {overdueDebtCount > 0 ? `${overdueDebtCount} overdue` : openDebtCount}
              </span>
            ) : null}
          </button>
        </div>

        {error ? (
          <p className="field-error is-inset">
            {error}
          </p>
        ) : null}

        {view === 'debts' ? (
          <div role="tabpanel" id="panel-debts" aria-labelledby="tab-debts">
            <DebtsPanel
              debts={debts}
              totals={debtTotals}
              loading={debtsLoading}
              activeCurrency={activeCurrency}
              onAdd={onAddDebt}
              onSettle={onSettleDebt}
              onEdit={onEditDebt}
              onDelete={onDeleteDebt}
              onToggleClosed={onToggleDebtClosed}
            />
          </div>
        ) : (
          <div role="tabpanel" id="panel-ledger" aria-labelledby="tab-ledger">
            <LedgerPanel
              transactions={transactions}
              walletsById={walletsById}
              summary={summary}
              breakdown={breakdown}
              loading={loading}
              ledger={ledger}
              onLedgerChange={onLedgerChange}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              onLoadMore={onLoadMore}
              selectedWallet={selectedWallet}
              activeCurrency={activeCurrency}
              onRefresh={onRefresh}
              onAddTransaction={onAddTransaction}
              onEditTransaction={onEditTransaction}
              onDeleteTransaction={onDeleteTransaction}
            />
          </div>
        )}
      </section>
    </div>
  );
}
