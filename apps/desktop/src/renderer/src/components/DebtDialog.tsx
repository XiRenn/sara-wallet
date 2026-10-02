/**
 * Records a debt, or edits its descriptive fields.
 *
 * The one thing this dialog must not do is imply that money has moved. The
 * footer says so explicitly, because a form that looks like the transaction
 * form but writes no ledger row is a form users will misread.
 *
 * Editing is narrower than creating on purpose. Once anything has been settled,
 * the principal, currency and direction are frozen by `tg_debts_guard_edits` —
 * changing any of them would reinterpret payments that already moved real
 * cash. Rather than show fields that fail on save, the dialog shows them
 * disabled with the reason.
 */

import React, { useEffect, useMemo, useState } from 'react';

import {
  formatCurrency,
  parseAmount,
  SUPPORTED_CURRENCIES,
  toISODate,
  type CreateDebtInput,
  type Debt,
  type DebtDirection,
  type UpdateDebtInput,
} from '@wallet/shared';

import { IconAlert, IconClose, IconHandCoins, IconReceipt } from './Icons';

export interface DebtDraft {
  kind: 'create' | 'update';
  /** Only meaningful when `kind` is `'update'`. */
  debtId: string | null;
  create: CreateDebtInput | null;
  update: UpdateDebtInput | null;
}

interface DebtDialogProps {
  open: boolean;
  /** Non-null while editing an existing debt. */
  editing: Debt | null;
  /** Pre-selects the currency for a new debt. */
  defaultCurrency: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (draft: DebtDraft) => Promise<void>;
}

const DIRECTIONS: Array<[DebtDirection, string]> = [
  ['RECEIVABLE', 'Owed to you'],
  ['PAYABLE', 'You owe'],
];

export function DebtDialog({
  open,
  editing,
  defaultCurrency,
  submitting,
  onClose,
  onSubmit,
}: DebtDialogProps) {
  const isEditing = editing !== null;

  const [direction, setDirection] = useState<DebtDirection>('RECEIVABLE');
  const [counterparty, setCounterparty] = useState('');
  const [amountText, setAmountText] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [issuedOn, setIssuedOn] = useState(toISODate(new Date()));
  const [dueOn, setDueOn] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Seed the draft every time the dialog opens, so a cancelled edit never
  // leaks into the next one.
  useEffect(() => {
    if (!open) return;

    if (editing) {
      setDirection(editing.direction);
      setCounterparty(editing.counterparty);
      setAmountText(String(editing.principal));
      setCurrency(editing.currency);
      setIssuedOn(editing.issued_on);
      setDueOn(editing.due_on ?? '');
      setNote(editing.note ?? '');
    } else {
      setDirection('RECEIVABLE');
      setCounterparty('');
      setAmountText('');
      setCurrency(defaultCurrency);
      setIssuedOn(toISODate(new Date()));
      setDueOn('');
      setNote('');
    }
    setFormError(null);
  }, [open, editing, defaultCurrency]);

  /** Editing is only locked once money has actually been posted against it. */
  const locked = isEditing && (editing?.settled ?? 0) > 0;

  const currencyOptions = useMemo(() => {
    const options = new Set<string>([currency, ...SUPPORTED_CURRENCIES.slice(0, 6)]);
    return Array.from(options);
  }, [currency]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const name = counterparty.trim();
    if (name.length === 0) {
      setFormError('Who is this with? A name or a shop is enough.');
      return;
    }

    // A due date before the issue date is refused by `debts_due_after_issue`;
    // catching it here turns a constraint name into a sentence.
    if (dueOn && issuedOn && dueOn < issuedOn) {
      setFormError('The due date cannot fall before the date it was recorded.');
      return;
    }

    setFormError(null);

    try {
      if (isEditing && editing) {
        await onSubmit({
          kind: 'update',
          debtId: editing.id,
          create: null,
          update: {
            counterparty: name,
            note: note.trim().length > 0 ? note.trim() : null,
            dueOn: dueOn || null,
          },
        });
        return;
      }

      const parsed = parseAmount(amountText);
      if (parsed === null || parsed <= 0) {
        setFormError('Enter an amount greater than zero.');
        return;
      }

      await onSubmit({
        kind: 'create',
        debtId: null,
        create: {
          direction,
          counterparty: name,
          principal: parsed,
          currency,
          issuedOn,
          dueOn: dueOn || null,
          note: note.trim().length > 0 ? note.trim() : null,
        },
        update: null,
      });
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not save that debt.');
    }
  };

  if (!open) return null;

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
        aria-labelledby="debt-dialog-title"
        onSubmit={handleSubmit}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="debt-dialog-title">
            {isEditing ? 'Edit debt' : 'Record a debt'}
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

        {locked ? (
          <p className="dialog-note has-icon">
            <IconAlert size={13} />
            <span>
              {formatCurrency(editing?.settled ?? 0, currency)} has already been settled against
              this, so the direction, amount and currency are fixed. Delete it and record a new one
              to change those.
            </span>
          </p>
        ) : null}

        {isEditing ? null : (
          <div className="segmented">
            {DIRECTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={direction === value}
                onClick={() => setDirection(value)}
              >
                {value === 'RECEIVABLE' ? (
                  <IconHandCoins size={14} />
                ) : (
                  <IconReceipt size={14} />
                )}
                {label}
              </button>
            ))}
          </div>
        )}

        <label className="label" htmlFor="debt-counterparty">
          {direction === 'RECEIVABLE' ? 'Who owes you' : 'Who you owe'}
        </label>
        <input
          className="input"
          id="debt-counterparty"
          value={counterparty}
          onChange={(event) => setCounterparty(event.target.value)}
          placeholder="A person, a shop, an institution"
          maxLength={80}
          autoFocus
        />

        <label className="label" htmlFor="debt-amount">
          Amount
        </label>
        <div className="amount-row">
          <span className="currency">{currency}</span>
          <input
            id="debt-amount"
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            placeholder="0"
            inputMode="decimal"
            disabled={locked}
          />
        </div>

        {isEditing ? null : (
          <>
            <span className="label">Currency</span>
            <div className="chip-row">
              {currencyOptions.map((code) => (
                <button
                  key={code}
                  type="button"
                  className="chip"
                  aria-pressed={code === currency}
                  onClick={() => setCurrency(code)}
                >
                  {code}
                </button>
              ))}
            </div>
          </>
        )}

        <label className="label" htmlFor="debt-issued">
          Recorded on
        </label>
        <input
          className="input"
          id="debt-issued"
          value={issuedOn}
          onChange={(event) => setIssuedOn(event.target.value)}
          placeholder="YYYY-MM-DD"
          maxLength={10}
          disabled={isEditing}
        />
        {isEditing ? (
          <p className="field-hint">The date it was recorded does not change.</p>
        ) : null}

        <label className="label" htmlFor="debt-due">
          Due on
        </label>
        <input
          className="input"
          id="debt-due"
          value={dueOn}
          onChange={(event) => setDueOn(event.target.value)}
          placeholder="YYYY-MM-DD"
          maxLength={10}
        />
        <p className="field-hint">
          Leave blank if there is no agreed date — an undated debt is never
          counted as overdue.
        </p>

        <label className="label" htmlFor="debt-note">
          Note
        </label>
        <textarea
          className="textarea"
          id="debt-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What it was for (optional)"
          maxLength={500}
          rows={2}
        />

        {formError ? (
          <p className="field-error" style={{ marginTop: 12 }}>
            <IconAlert size={14} />
            {formError}
          </p>
        ) : null}

        <div className="dialog-actions">
          <p className="dialog-note" style={{ marginRight: 'auto', marginBottom: 0 }}>
            {isEditing
              ? 'Editing a debt never moves money.'
              : 'Recording a debt moves no money. Your wallets change when you settle it.'}
          </p>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? (
              <span className="spinner" aria-hidden="true" />
            ) : isEditing ? (
              'Save changes'
            ) : (
              'Record debt'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
