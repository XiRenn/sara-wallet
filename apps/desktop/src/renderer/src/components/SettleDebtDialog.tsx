/**
 * Settles a debt with a real ledger row.
 *
 * This is the only place in the AP/AR flow where money moves, and the dialog is
 * built to make that obvious: the wallet is chosen explicitly, the amount is
 * capped at what is outstanding, and the footer says which ledger row will be
 * written.
 *
 * The wallet list is filtered to the debt's currency rather than letting the
 * user pick a mismatched one and be refused by the trigger. Cross-currency
 * settlement needs an exchange rate this app does not model, so offering the
 * option would be offering a guaranteed failure.
 */

import React, { useEffect, useMemo, useState } from 'react';

import {
  defaultSettlementCategory,
  formatCurrency,
  parseAmount,
  settlementTypeFor,
  toISODate,
  type Debt,
  type SettleDebtInput,
  type Wallet,
} from '@wallet/shared';

import { IconAlert, IconArrowDownRight, IconArrowUpRight, IconClose } from './Icons';

interface SettleDebtDialogProps {
  open: boolean;
  /** The debt being settled. Null closes the dialog. */
  debt: Debt | null;
  wallets: Wallet[];
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: SettleDebtInput) => Promise<void>;
}

export function SettleDebtDialog({
  open,
  debt,
  wallets,
  submitting,
  onClose,
  onSubmit,
}: SettleDebtDialogProps) {
  const [amountText, setAmountText] = useState('');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [date, setDate] = useState(toISODate(new Date()));
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Only wallets that can legally settle this debt. The trigger compares the
   * wallet's currency against the debt's and refuses a mismatch with 23514, so
   * an MMK debt simply has no THB wallets to offer.
   */
  const eligibleWallets = useMemo(
    () => (debt ? wallets.filter((wallet) => wallet.currency === debt.currency) : []),
    [wallets, debt],
  );

  useEffect(() => {
    if (!open || !debt) return;
    // Defaulting to the full outstanding amount is the common case: most
    // settlements clear the debt, and the amount is the field people get wrong.
    setAmountText(String(debt.outstanding));
    setWalletId(eligibleWallets[0]?.id ?? null);
    setDate(toISODate(new Date()));
    setNote('');
    setFormError(null);
  }, [open, debt, eligibleWallets]);

  if (!open || !debt) return null;

  const isReceivable = debt.direction === 'RECEIVABLE';
  const type = settlementTypeFor(debt.direction);
  const category = defaultSettlementCategory(debt.direction);
  const wallet = eligibleWallets.find((candidate) => candidate.id === walletId) ?? null;

  const parsed = parseAmount(amountText);
  const remaining = parsed === null ? debt.outstanding : debt.outstanding - parsed;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (walletId === null) {
      setFormError('Choose the wallet the money moves through.');
      return;
    }
    if (parsed === null || parsed <= 0) {
      setFormError('Enter an amount greater than zero.');
      return;
    }
    // The trigger refuses this too, with a message naming the two figures. The
    // check here saves the round trip and reads the same way.
    if (parsed - debt.outstanding > 0.005) {
      setFormError(
        `That is more than is outstanding (${formatCurrency(debt.outstanding, debt.currency)}).`,
      );
      return;
    }

    setFormError(null);
    try {
      await onSubmit({
        debtId: debt.id,
        walletId,
        amount: parsed,
        date,
        note: note.trim().length > 0 ? note.trim() : undefined,
        category,
      });
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not record that settlement.');
    }
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settle-dialog-title"
        onSubmit={handleSubmit}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="settle-dialog-title">
            {isReceivable ? 'Collect from' : 'Pay'} {debt.counterparty}
          </h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close"
            onClick={onClose}
            disabled={submitting}
          >
            <IconClose size={17} />
          </button>
        </div>

        <dl className="settle-figures">
          <div>
            <dt>Still outstanding</dt>
            <dd>{formatCurrency(debt.outstanding, debt.currency)}</dd>
          </div>
          <div>
            <dt>Original amount</dt>
            <dd>{formatCurrency(debt.principal, debt.currency)}</dd>
          </div>
          <div>
            <dt>After this</dt>
            <dd>{formatCurrency(Math.max(0, remaining), debt.currency)}</dd>
          </div>
        </dl>

        <label className="label" htmlFor="settle-amount">
          Amount
        </label>
        <div className="amount-row">
          <span className="currency">{debt.currency}</span>
          <input
            id="settle-amount"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            placeholder="0"
            inputMode="decimal"
            autoFocus
          />
        </div>
        <div className="chip-row">
          <button
            type="button"
            className="chip"
            aria-pressed={parsed === debt.outstanding}
            onClick={() => setAmountText(String(debt.outstanding))}
          >
            Settle in full
          </button>
          {debt.outstanding >= 2 ? (
            <button
              type="button"
              className="chip"
              onClick={() => setAmountText(String(Math.round(debt.outstanding / 2)))}
            >
              Half
            </button>
          ) : null}
        </div>

        <span className="label">Wallet</span>
        {eligibleWallets.length === 0 ? (
          <p className="field-error">
            <IconAlert size={14} />
            You have no {debt.currency} wallet to settle this from. Create one first — settling
            across currencies needs an exchange rate this app does not model.
          </p>
        ) : (
          <div className="chip-row">
            {eligibleWallets.map((option) => (
              <button
                key={option.id}
                type="button"
                className="chip"
                aria-pressed={option.id === walletId}
                onClick={() => setWalletId(option.id)}
              >
                {option.name} · {formatCurrency(option.balance, option.currency)}
              </button>
            ))}
          </div>
        )}

        <label className="label" htmlFor="settle-date">
          Date
        </label>
        <input
          className="input"
          id="settle-date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          placeholder="YYYY-MM-DD"
          maxLength={10}
        />

        <label className="label" htmlFor="settle-note">
          Note
        </label>
        <input
          className="input"
          id="settle-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Optional"
          maxLength={500}
        />

        {formError ? (
          <p className="field-error" style={{ marginTop: 12 }}>
            <IconAlert size={14} />
            {formError}
          </p>
        ) : null}

        <p className="dialog-note has-icon" style={{ marginTop: 14 }}>
          {isReceivable ? <IconArrowUpRight size={13} /> : <IconArrowDownRight size={13} />}
          <span>
            This writes a real {isReceivable ? 'income' : 'expense'} of{' '}
            {formatCurrency(parsed ?? 0, debt.currency)} under “{category}”
            {wallet ? ` to ${wallet.name}` : ''}, and moves that wallet's balance.
          </span>
        </p>

        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="submit"
            className={`btn ${isReceivable ? 'btn-income' : 'btn-expense'}`}
            disabled={submitting || eligibleWallets.length === 0}
          >
            {submitting ? (
              <span className="spinner" aria-hidden="true" />
            ) : isReceivable ? (
              'Record collection'
            ) : (
              'Record payment'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
