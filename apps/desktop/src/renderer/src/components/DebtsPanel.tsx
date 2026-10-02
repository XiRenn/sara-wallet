/**
 * The Accounts Payable / Receivable view.
 *
 * Presentational, like every other screen here: the data arrives as props and
 * every action is a callback. `useDebts` in `@wallet/shared` owns the state.
 *
 * Two presentation rules this file exists to enforce:
 *
 *   1. **A debt is never coloured red or green.** Those two tokens mean "money
 *      came in" and "money went out" everywhere else in the app, and an unpaid
 *      debt is neither — nothing has moved yet. Direction is stated in a badge
 *      instead. The only red on the page is the overdue accent, which means
 *      "late", not "income".
 *   2. **Settled and closed are shown differently from open.** A settled debt
 *      is a receipt; a closed one is an admission that it will not be paid.
 *      Collapsing them would hide which of the two happened.
 */

import React, { useMemo, useState } from 'react';

import {
  debtProgress,
  daysUntilDue,
  debtStatus,
  formatCurrency,
  formatDate,
  type CurrencyCode,
  type Debt,
  type DebtTotals,
} from '@wallet/shared';

import {
  IconCheck,
  IconClock,
  IconClose,
  IconHandCoins,
  IconInbox,
  IconLock,
  IconPencil,
  IconPlus,
  IconReceipt,
  IconTrash,
} from './Icons';
import { categoryStyle } from '../theme';

/** How many rows to show before the list is folded behind "Show all". */
const COLLAPSED_ROWS = 6;

interface DebtsPanelProps {
  /** Every debt in scope, already ordered most-urgent-first. */
  debts: Debt[];
  totals: DebtTotals;
  loading: boolean;
  /** The currency the wallet sidebar is currently showing. */
  activeCurrency: CurrencyCode;
  onAdd: () => void;
  onSettle: (debt: Debt) => void;
  onEdit: (debt: Debt) => void;
  onDelete: (debt: Debt) => void;
  /** Closes an unpaid debt, or reopens a closed one. */
  onToggleClosed: (debt: Debt) => void;
}

/** `'4 Oct'` this year, `'4 Oct 2027'` otherwise. */
function dueLabel(iso: string): string {
  const label = formatDate(iso, 'medium'); // '4 Oct 2026'
  return iso.slice(0, 4) === String(new Date().getFullYear())
    ? label.replace(/\s\d{4}$/, '')
    : label;
}

/** The plain-English reading of a due date, which is what the user wants. */
function duePhrase(debt: Debt): string {
  const days = daysUntilDue(debt.due_on);
  if (days === null) return 'No due date';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days > 0) return `Due in ${days} days`;
  const late = Math.abs(days);
  return late === 1 ? '1 day overdue' : `${late} days overdue`;
}

function directionLabel(debt: Debt): string {
  return debt.direction === 'RECEIVABLE' ? 'Owed to you' : 'You owe';
}

function statusBadge(debt: Debt) {
  const status = debtStatus(debt);
  if (status === 'OVERDUE') return <span className="badge badge-overdue">Overdue</span>;
  if (status === 'DUE_SOON') return <span className="badge badge-due-soon">Due soon</span>;
  if (status === 'SETTLED') return <span className="badge badge-settled">Settled</span>;
  if (status === 'CLOSED') return <span className="badge badge-closed">Closed</span>;
  return null;
}

export function DebtsPanel({
  debts,
  totals,
  loading,
  activeCurrency,
  onAdd,
  onSettle,
  onEdit,
  onDelete,
  onToggleClosed,
}: DebtsPanelProps) {
  const [showAll, setShowAll] = useState(false);

  /**
   * The active currency first, then the rest. A user holding MMK and THB needs
   * both totals and must not see them added together — the whole reason
   * `get_debt_totals()` groups by currency.
   */
  const currencies = useMemo(() => {
    const ordered = [...totals.byCurrency].sort((a, b) => {
      if (a.currency === activeCurrency) return -1;
      if (b.currency === activeCurrency) return 1;
      return a.currency.localeCompare(b.currency);
    });
    return ordered;
  }, [totals.byCurrency, activeCurrency]);

  const visible = showAll ? debts : debts.slice(0, COLLAPSED_ROWS);
  const hidden = debts.length - visible.length;

  const overdueCount = useMemo(
    () => debts.filter((debt) => debtStatus(debt) === 'OVERDUE').length,
    [debts],
  );

  return (
    <>
      {currencies.length === 0 ? null : (
        <div className="debt-summary-blocks">
          {currencies.map((entry) => (
            <div key={entry.currency}>
              {currencies.length > 1 ? (
                <p className="label debt-group-label">
                  {entry.currency}
                </p>
              ) : null}

              <div
                className={currencies.length > 1 ? 'debt-summary is-grouped' : 'debt-summary'}
              >
                <div className="summary-tile is-receivable">
                  <div className="summary-tile-head">
                    <span className="tile-icon">
                      <IconHandCoins size={15} />
                    </span>
                    <span className="summary-label">Owed to you</span>
                  </div>
                  <div className="summary-value">
                    {formatCurrency(entry.receivableOutstanding, entry.currency)}
                  </div>
                  <div className="summary-sub">
                    {entry.receivableOverdue > 0
                      ? `${formatCurrency(entry.receivableOverdue, entry.currency)} overdue`
                      : 'Nothing overdue'}
                  </div>
                </div>

                <div className="summary-tile is-payable">
                  <div className="summary-tile-head">
                    <span className="tile-icon">
                      <IconReceipt size={15} />
                    </span>
                    <span className="summary-label">You owe</span>
                  </div>
                  <div className="summary-value">
                    {formatCurrency(entry.payableOutstanding, entry.currency)}
                  </div>
                  <div className="summary-sub">
                    {entry.payableOverdue > 0
                      ? `${formatCurrency(entry.payableOverdue, entry.currency)} overdue`
                      : 'Nothing overdue'}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div>
          <h2 className="panel-title">Debts</h2>
          <span className="toolbar-sub">
            {debts.length === 0
              ? 'Nothing recorded'
              : `${debts.length} record${debts.length === 1 ? '' : 's'}`}
            {overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}
          </span>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <IconPlus size={15} />
            Record a debt
          </button>
        </div>
      </div>

      <div className="debt-list">
        {loading && debts.length === 0 ? (
          <div aria-hidden="true">
            {Array.from({ length: 3 }, (_, index) => (
              <div className="skeleton-row" key={index} style={{ marginBottom: 8 }}>
                <span className="skeleton" />
                <span className="skeleton" />
                <span className="skeleton" />
                <span className="skeleton" />
              </div>
            ))}
          </div>
        ) : debts.length === 0 ? (
          <div className="empty-state">
            <IconInbox size={34} />
            <strong>No debts recorded</strong>
            <span>
              Record money you have lent or borrowed. Nothing moves in your
              wallets until you settle it.
            </span>
            <button type="button" className="link-btn" onClick={onAdd}>
              <IconPlus size={14} />
              Record your first debt
            </button>
          </div>
        ) : (
          visible.map((debt) => {
            const status = debtStatus(debt);
            const progress = debtProgress(debt);
            const settled = debt.settled;
            const isDone = status === 'SETTLED' || status === 'CLOSED';

            return (
              <div
                key={debt.id}
                className={[
                  'debt-row',
                  status === 'OVERDUE' ? 'is-overdue' : '',
                  status === 'SETTLED' ? 'is-settled' : '',
                  status === 'CLOSED' ? 'is-closed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="debt-avatar" style={categoryStyle(debt.counterparty)} aria-hidden="true">
                  {debt.counterparty.trim().charAt(0) || '?'}
                </span>

                <div className="debt-body">
                  <div className="debt-top">
                    <span className="debt-name" title={debt.counterparty}>
                      {debt.counterparty}
                    </span>
                    <span className="badge badge-direction">{directionLabel(debt)}</span>
                    {statusBadge(debt)}
                  </div>

                  <div className="debt-meta">
                    {isDone ? (
                      <IconLock size={12} />
                    ) : (
                      <IconClock size={12} />
                    )}
                    <span>
                      {isDone
                        ? status === 'CLOSED'
                          ? 'Closed — no longer counted'
                          : 'Paid in full'
                        : duePhrase(debt)}
                    </span>
                    {debt.due_on && !isDone ? <span>· {dueLabel(debt.due_on)}</span> : null}
                    {debt.note ? (
                      <span className="debt-note" title={debt.note}>
                        · {debt.note}
                      </span>
                    ) : null}
                  </div>

                  {isDone ? null : (
                    <div className="debt-progress">
                      <span className="debt-track">
                        <span
                          className="debt-fill"
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                      </span>
                      <span className="debt-progress-label">
                        {settled > 0
                          ? `${formatCurrency(settled, debt.currency)} of ${formatCurrency(
                              debt.principal,
                              debt.currency,
                            )} settled`
                          : `${formatCurrency(debt.principal, debt.currency)} total`}
                      </span>
                    </div>
                  )}
                </div>

                <div className="debt-figures">
                  <span className="debt-outstanding">
                    {isDone
                      ? formatCurrency(0, debt.currency)
                      : formatCurrency(debt.outstanding, debt.currency)}
                  </span>

                  <div className="debt-actions">
                    {isDone ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onToggleClosed(debt)}
                        title={
                          status === 'CLOSED'
                            ? 'Start counting this debt again'
                            : 'Reopen so it can be settled again'
                        }
                      >
                        {status === 'CLOSED' ? 'Reopen' : 'Adjust'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => onSettle(debt)}
                      >
                        <IconCheck size={14} />
                        Settle
                      </button>
                    )}

                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onEdit(debt)}
                      title="Edit this debt"
                      aria-label={`Edit the debt with ${debt.counterparty}`}
                    >
                      <IconPencil size={14} />
                    </button>

                    {status === 'CLOSED' ? null : (
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => onToggleClosed(debt)}
                        title="Close without settling — written off or forgiven"
                        aria-label={`Close the debt with ${debt.counterparty}`}
                      >
                        <IconClose size={14} />
                      </button>
                    )}

                    <button
                      type="button"
                      className="icon-btn is-danger"
                      onClick={() => onDelete(debt)}
                      title="Delete this debt. Its settlements stay in the ledger."
                      aria-label={`Delete the debt with ${debt.counterparty}`}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {hidden > 0 ? (
          <button type="button" className="btn btn-ghost" onClick={() => setShowAll(true)}>
            Show {hidden} more
          </button>
        ) : null}
      </div>
    </>
  );
}
