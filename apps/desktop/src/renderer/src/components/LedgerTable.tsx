import React from 'react';

import { formatCurrency, formatDate, type Transaction, type Wallet } from '@wallet/shared';

import { IconTrash } from './Icons';
import { categoryStyle } from '../theme';

interface WalletEndProps {
  name: string | undefined;
  /** The end this row actually moves money in or out of. */
  own: boolean;
}

/**
 * One end of a transfer.
 *
 * Only the row's own end is a pill, so the Wallet column keeps meaning the
 * same thing on every line — "this row touched *this* wallet" — and the
 * Amount column's `−` / `+` says which way. Both ends would be a wall of
 * pills and neither would read as the subject of the row.
 */
function WalletEnd({ name, own }: WalletEndProps) {
  const label = name ?? 'Unknown wallet';
  return own ? <span className="pill">{label}</span> : <span className="wallet-pair-name">{label}</span>;
}

/**
 * The Wallet cell.
 *
 * An ordinary row has one wallet and shows it. A transfer leg is one half of a
 * pair, and a leg on its own cannot say where the money came from or went —
 * `iWallet` out and `Cash` in reads as two unrelated lines. So a leg shows
 * both ends in `from → to` order.
 *
 * The pair is only known when the counterpart resolved; a lone leg falls back
 * to the plain single-wallet cell rather than rendering half a transfer.
 */
function WalletCell({
  transaction,
  walletsById,
}: {
  transaction: Transaction;
  walletsById: Map<string, Wallet>;
}) {
  const own = walletsById.get(transaction.wallet_id);
  const counterpartId = transaction.transfer_counterpart_wallet_id;
  const counterpart = counterpartId === null ? undefined : walletsById.get(counterpartId);

  if (counterpart === undefined) {
    return <span className="pill">{own?.name ?? 'Unknown wallet'}</span>;
  }

  const isSource = transaction.type === 'EXPENSE';
  const from = isSource ? own : counterpart;
  const to = isSource ? counterpart : own;

  return (
    <span className="wallet-pair" title={`From ${from?.name ?? '?'} to ${to?.name ?? '?'}`}>
      <WalletEnd name={from?.name} own={isSource} />
      <span className="wallet-pair-arrow" aria-hidden="true">
        →
      </span>
      <WalletEnd name={to?.name} own={!isSource} />
    </span>
  );
}

interface LedgerTableProps {
  transactions: Transaction[];
  walletsById: Map<string, Wallet>;
  /** Currency used to render amounts whose wallet is unknown. */
  fallbackCurrency: string;
  /** Opens the edit dialog. Transfer legs are not editable, so they are skipped. */
  onEdit: (transaction: Transaction) => void;
  onDelete: (transaction: Transaction) => void;
}

/**
 * The ledger. Nothing here is rendered as HTML — every value is text, so a
 * note containing markup cannot execute.
 *
 * Clicking a row opens it for editing, except for transfer legs: those are a
 * matched pair, and the database refuses to change one without the other.
 */
export function LedgerTable({
  transactions,
  walletsById,
  fallbackCurrency,
  onEdit,
  onDelete,
}: LedgerTableProps) {
  if (transactions.length === 0) {
    return <div className="empty-state">No transactions to show.</div>;
  }

  return (
    <table className="ledger">
      <thead>
        <tr>
          <th>Date</th>
          <th>Wallet</th>
          <th>Category</th>
          <th>Note</th>
          <th className="col-amount">Amount</th>
          <th className="col-actions" aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {transactions.map((transaction) => {
          const wallet = walletsById.get(transaction.wallet_id);
          const currency = wallet?.currency ?? fallbackCurrency;
          const isIncome = transaction.type === 'INCOME';
          const isTransfer = transaction.transfer_group_id !== null;
          const editable = !isTransfer;

          const amountClass = isTransfer
            ? 'amount-transfer'
            : isIncome
              ? 'amount-income'
              : 'amount-expense';

          return (
            <tr
              key={transaction.id}
              className={editable ? 'ledger-row is-editable' : 'ledger-row'}
              tabIndex={editable ? 0 : -1}
              title={editable ? 'Click to edit' : 'One leg of a transfer — edit it as a pair'}
              onClick={() => {
                if (editable) onEdit(transaction);
              }}
              onKeyDown={(event) => {
                if (!editable) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onEdit(transaction);
                }
              }}
            >
              <td className="col-date">{formatDate(transaction.date, 'short')}</td>
              <td className="col-wallet">
                <WalletCell transaction={transaction} walletsById={walletsById} />
              </td>
              <td className="col-category">
                {isTransfer ? (
                  <span className="pill pill-transfer">⇄ Transfer</span>
                ) : (
                  <>
                    {/* Same hue the category has in the composition bar and in
                        the filter chips, so a row is recognisable at a glance. */}
                    <span
                      className="cat-dot"
                      style={categoryStyle(transaction.category)}
                      aria-hidden="true"
                    />
                    {transaction.category}
                  </>
                )}
              </td>
              <td className="col-note" title={transaction.note ?? undefined}>
                {transaction.note ?? '—'}
              </td>
              <td className={`col-amount ${amountClass}`}>
                {isIncome ? '+' : '−'}
                {formatCurrency(transaction.amount, currency)}
              </td>
              <td className="col-actions">
                <button
                  type="button"
                  className="row-delete"
                  title="Delete transaction"
                  aria-label={`Delete ${transaction.category} transaction`}
                  onClick={(event) => {
                    // Keep the row's edit handler out of it.
                    event.stopPropagation();
                    onDelete(transaction);
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
