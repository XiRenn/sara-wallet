/**
 * The ledger view: month breakdown, filters, and the transaction table.
 *
 * Extracted from `DashboardScreen` so the two main views are peers —
 * `LedgerPanel` and `DebtsPanel` are siblings behind the tab strip, and the
 * screen above them only decides which one is showing. Presentational, like
 * everything else: `useTransactions` owns the data.
 */

import React, { useMemo } from 'react';

import {
  addMonths,
  ALL_CATEGORIES,
  formatCurrency,
  formatDate,
  hasLedgerFilters,
  toMonthKey,
  type CategoryBreakdownEntry,
  type CurrencyCode,
  type LedgerControls,
  type MonthlySummary,
  type Transaction,
  type TransactionType,
  type Wallet,
} from '@wallet/shared';

import { LedgerTable } from './LedgerTable';
import {
  IconClose,
  IconChevronLeft,
  IconChevronRight,
  IconInbox,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTransfer,
} from './Icons';
import { categoryStyle } from '../theme';

/** `null` means "no direction filter" rather than "unknown direction". */
const TYPE_FILTERS: ReadonlyArray<{ label: string; value: TransactionType | null }> = [
  { label: 'All', value: null },
  { label: 'Money in', value: 'INCOME' },
  { label: 'Money out', value: 'EXPENSE' },
];

/**
 * How many categories the composition bar and its legend show. The rest are
 * still counted in the total — the bar renormalises by amount, so dropping the
 * tail never makes it under-fill.
 */
const BREAKDOWN_LIMIT = 7;

/** Placeholder rows shown on a cold load, matching the real table's rhythm. */
function LedgerSkeleton() {
  return (
    <div aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ))}
    </div>
  );
}

export interface LedgerPanelProps {
  transactions: Transaction[];
  walletsById: Map<string, Wallet>;
  summary: MonthlySummary | null;
  breakdown: CategoryBreakdownEntry[];
  loading: boolean;
  ledger: LedgerControls;
  onLedgerChange: (patch: Partial<LedgerControls>) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  /** Null when "All wallets" is selected. */
  selectedWallet: Wallet | null;
  activeCurrency: CurrencyCode;
  onRefresh: () => void;
  onAddTransaction: () => void;
  onEditTransaction: (transaction: Transaction) => void;
  onDeleteTransaction: (transaction: Transaction) => void;
}

export function LedgerPanel({
  transactions,
  walletsById,
  summary,
  breakdown,
  loading,
  ledger,
  onLedgerChange,
  hasMore,
  isLoadingMore,
  onLoadMore,
  selectedWallet,
  activeCurrency,
  onRefresh,
  onAddTransaction,
  onEditTransaction,
  onDeleteTransaction,
}: LedgerPanelProps) {
  const monthLabel = formatDate(ledger.month, 'month');
  // Nothing to see in the future — the ledger has no rows there.
  const canGoForward = toMonthKey(ledger.month) < toMonthKey(new Date());
  const filtersActive = hasLedgerFilters(ledger);

  /** The full month's spending, including the categories past the display cap. */
  const breakdownTotal = useMemo(
    () => breakdown.reduce((sum, entry) => sum + entry.total, 0),
    [breakdown],
  );
  const breakdownShown = useMemo(() => breakdown.slice(0, BREAKDOWN_LIMIT), [breakdown]);

  /** What the ledger area should say when there is nothing in it. */
  const emptyCopy = filtersActive
    ? {
        title: 'Nothing matches those filters',
        hint: 'Try a different month, or clear the search and category chips.',
      }
    : ledger.scope === 'all'
      ? {
          title: 'No transactions yet',
          hint: 'Use “Add transaction” to record your first one.',
        }
      : {
          title: `Nothing recorded in ${monthLabel}`,
          hint: 'Step to another month, or switch to All time to see everything.',
        };

  return (
    <>
      {breakdownShown.length > 0 ? (
        <div className="breakdown">
          <div className="breakdown-head">
            <span className="summary-label">Where it went · {monthLabel}</span>
            <span className="breakdown-total">
              {formatCurrency(breakdownTotal, activeCurrency)} across {breakdown.length}{' '}
              {breakdown.length === 1 ? 'category' : 'categories'}
            </span>
          </div>

          {/* One stacked bar instead of a track per category: the same
              proportions, a third of the height, and directly comparable. */}
          <div className="breakdown-track">
            {breakdownShown.map((entry) => {
              const share = breakdownTotal > 0 ? entry.total / breakdownTotal : 0;
              return (
                <div
                  key={entry.category}
                  className="breakdown-segment"
                  style={{
                    ...categoryStyle(entry.category),
                    flexGrow: entry.total > 0 ? entry.total : 1,
                  }}
                  title={`${entry.category} · ${formatCurrency(
                    entry.total,
                    activeCurrency,
                  )} · ${Math.round(share * 100)}%`}
                />
              );
            })}
          </div>

          <div className="breakdown-legend">
            {breakdownShown.map((entry) => {
              const share = breakdownTotal > 0 ? entry.total / breakdownTotal : 0;
              return (
                <div className="legend-item" key={entry.category}>
                  <span
                    className="legend-dot"
                    style={categoryStyle(entry.category)}
                    aria-hidden="true"
                  />
                  <span className="legend-name" title={entry.category}>
                    {entry.category}
                  </span>
                  <span className="legend-value">
                    {formatCurrency(entry.total, activeCurrency)} ·{' '}
                    {Math.round(share * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="toolbar">
        <div>
          <h2 className="panel-title">Transactions</h2>
          <span className="toolbar-sub">
            {selectedWallet ? `Only ${selectedWallet.name}` : 'All wallets'} ·{' '}
            {ledger.scope === 'all' ? 'every month' : monthLabel} ·{' '}
            {transactions.length}
            {hasMore ? '+' : ''} loaded
          </span>
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onRefresh}
            disabled={loading}
            title="Re-read wallets and the ledger from the database"
          >
            <IconRefresh size={15} />
            Refresh
          </button>
          <button type="button" className="btn btn-primary" onClick={onAddTransaction}>
            <IconPlus size={15} />
            Add transaction
          </button>
        </div>
      </div>

      {/* ── Ledger controls ─────────────────────────────────────────────── */}
      <div className="filter-bar">
        <div className="filter-row">
          <div className="month-stepper">
            <button
              type="button"
              className="month-btn"
              aria-label="Previous month"
              onClick={() => onLedgerChange({ month: addMonths(ledger.month, -1) })}
            >
              <IconChevronLeft size={15} />
            </button>
            <span className="month-label">{monthLabel}</span>
            <button
              type="button"
              className="month-btn"
              aria-label="Next month"
              disabled={!canGoForward}
              onClick={() => onLedgerChange({ month: addMonths(ledger.month, 1) })}
            >
              <IconChevronRight size={15} />
            </button>
          </div>

          <button
            type="button"
            className="chip"
            aria-pressed={ledger.scope === 'all'}
            title="Ignore the month and page through the whole ledger"
            onClick={() => onLedgerChange({ scope: ledger.scope === 'all' ? 'month' : 'all' })}
          >
            All time
          </button>

          <div className="search-field">
            <IconSearch size={15} />
            <input
              className="input"
              value={ledger.search}
              onChange={(event) => onLedgerChange({ search: event.target.value })}
              placeholder="Search notes and categories"
              maxLength={80}
              aria-label="Search transactions"
            />
          </div>

          {filtersActive ? (
            <button
              type="button"
              className="link-btn"
              onClick={() => onLedgerChange({ search: '', type: null, category: null })}
            >
              <IconClose size={13} />
              Clear filters
            </button>
          ) : null}
        </div>

        <div className="chip-row">
          {TYPE_FILTERS.map((option) => (
            <button
              key={option.label}
              type="button"
              className="chip"
              aria-pressed={ledger.type === option.value}
              onClick={() => onLedgerChange({ type: option.value })}
            >
              {option.label}
            </button>
          ))}

          <span className="chip-divider" aria-hidden="true" />

          {ALL_CATEGORIES.map((option) => (
            <button
              key={option}
              type="button"
              className="chip"
              aria-pressed={ledger.category === option}
              // Clicking the active chip clears it, so the row is its own
              // off switch rather than needing a separate "Any" chip.
              onClick={() =>
                onLedgerChange({ category: ledger.category === option ? null : option })
              }
            >
              <span className="chip-dot" style={categoryStyle(option)} aria-hidden="true" />
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrap">
        {loading && transactions.length === 0 ? (
          <LedgerSkeleton />
        ) : transactions.length === 0 ? (
          <div className="empty-state">
            <IconInbox size={34} />
            <strong>{emptyCopy.title}</strong>
            <span>{emptyCopy.hint}</span>
          </div>
        ) : (
          <LedgerTable
            transactions={transactions}
            walletsById={walletsById}
            fallbackCurrency={activeCurrency}
            onEdit={onEditTransaction}
            onDelete={onDeleteTransaction}
          />
        )}

        {transactions.length > 0 ? (
          <div className="load-more-row">
            {isLoadingMore ? (
              <span className="spinner" aria-hidden="true" />
            ) : hasMore ? (
              <button type="button" className="btn btn-ghost" onClick={onLoadMore}>
                Load more
              </button>
            ) : (
              <span className="ledger-footnote">
                That is the whole ledger — {transactions.length} transaction
                {transactions.length === 1 ? '' : 's'}.
              </span>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
