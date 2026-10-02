import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  categoriesForType,
  formatCurrency,
  parseAmount,
  toISODate,
  type Transaction,
  type TransactionType,
  type Wallet,
} from '@wallet/shared';

import { IconAlert, IconClose } from './Icons';
import { categoryStyle } from '../theme';

/** The dialog can record an income, an expense, or move money between wallets. */
type DialogMode = TransactionType | 'TRANSFER';

export interface TransactionDraft {
  kind: 'transaction';
  walletId: string;
  type: TransactionType;
  amount: number;
  category: string;
  note: string | null;
  /** ISO timestamp. */
  date: string;
}

export interface TransferDraft {
  kind: 'transfer';
  fromWalletId: string;
  toWalletId: string;
  amount: number;
  note: string | null;
  /** ISO timestamp. */
  date: string;
}

export type SheetSubmission = TransactionDraft | TransferDraft;

interface AddTransactionDialogProps {
  open: boolean;
  wallets: Wallet[];
  defaultWalletId: string | null;
  submitting: boolean;
  /** Pass a transaction to edit it. Transfers cannot be edited — see below. */
  editing?: Transaction | null;
  onClose: () => void;
  onSubmit: (submission: SheetSubmission) => Promise<void>;
}

type DatePreset = 'today' | 'yesterday' | 'custom';

function resolveDate(preset: DatePreset, custom: string): Date | null {
  if (preset === 'today') return new Date();
  if (preset === 'yesterday') {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(custom.trim())) return null;
  const parsed = new Date(`${custom.trim()}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Modal for recording or editing a transaction, or for moving money between
 * two wallets.
 *
 * Editing a transfer leg is impossible by design — the database rejects it,
 * because changing one leg would leave the pair unbalanced and the balances
 * with it. So the TRANSFER option is hidden while editing.
 */
export function AddTransactionDialog({
  open,
  wallets,
  defaultWalletId,
  submitting,
  editing = null,
  onClose,
  onSubmit,
}: AddTransactionDialogProps) {
  const isEditing = editing !== null;

  const [mode, setMode] = useState<DialogMode>('EXPENSE');
  const [amountText, setAmountText] = useState('');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [toWalletId, setToWalletId] = useState<string | null>(null);
  const [category, setCategory] = useState('Food');
  const [note, setNote] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  const [customDate, setCustomDate] = useState(toISODate(new Date()));
  const [formError, setFormError] = useState<string | null>(null);

  const amountRef = useRef<HTMLInputElement>(null);

  // Seed the draft every time the dialog opens.
  useEffect(() => {
    if (!open) return;

    if (editing) {
      const editingDate = toISODate(new Date(editing.date));
      setMode(editing.type);
      setAmountText(String(editing.amount));
      setWalletId(editing.wallet_id);
      setToWalletId(null);
      setCategory(editing.category);
      setNote(editing.note ?? '');
      setCustomDate(editingDate);
      setDatePreset(editingDate === toISODate(new Date()) ? 'today' : 'custom');
    } else {
      const firstWalletId = defaultWalletId ?? wallets[0]?.id ?? null;
      setMode('EXPENSE');
      setAmountText('');
      setWalletId(firstWalletId);
      setToWalletId(wallets.find((w) => w.id !== firstWalletId)?.id ?? null);
      setCategory(categoriesForType('EXPENSE')[0] as string);
      setNote('');
      setDatePreset('today');
      setCustomDate(toISODate(new Date()));
    }

    setFormError(null);
    amountRef.current?.focus();
  }, [open, editing, defaultWalletId, wallets]);

  // Keep the destination valid when the source changes.
  useEffect(() => {
    if (toWalletId && wallets.some((wallet) => wallet.id === toWalletId)) return;
    setToWalletId(wallets.find((wallet) => wallet.id !== walletId)?.id ?? null);
  }, [wallets, toWalletId, walletId]);

  // Escape closes the dialog, unless a save is in flight.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, submitting, onClose]);

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === walletId) ?? null,
    [wallets, walletId],
  );

  const destinationWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === toWalletId) ?? null,
    [wallets, toWalletId],
  );

  if (!open) return null;

  const isTransfer = mode === 'TRANSFER';
  const categories = isTransfer ? [] : categoriesForType(mode);

  const handleModeChange = (next: DialogMode) => {
    setMode(next);
    setFormError(null);
    if (next === 'TRANSFER') return;
    const nextCategories = categoriesForType(next);
    if (!nextCategories.includes(category)) setCategory(nextCategories[0] as string);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const amount = parseAmount(amountText);
    if (amount === null) {
      setFormError('Enter an amount greater than zero.');
      return;
    }

    const date = resolveDate(datePreset, customDate);
    if (!date) {
      setFormError('Enter the date as YYYY-MM-DD.');
      return;
    }

    if (isTransfer) {
      if (!walletId || !toWalletId) {
        setFormError('Choose both a source and a destination wallet.');
        return;
      }
      if (walletId === toWalletId) {
        setFormError('Choose two different wallets.');
        return;
      }
      // The server refuses cross-currency transfers too — this is only so the
      // user finds out before waiting on a round trip.
      if (
        selectedWallet &&
        destinationWallet &&
        selectedWallet.currency !== destinationWallet.currency
      ) {
        setFormError(
          `Cannot transfer between ${selectedWallet.currency} and ${destinationWallet.currency} — that needs an exchange rate.`,
        );
        return;
      }

      setFormError(null);
      try {
        await onSubmit({
          kind: 'transfer',
          fromWalletId: walletId,
          toWalletId,
          amount,
          note: note.trim().length > 0 ? note.trim() : null,
          date: date.toISOString(),
        });
        onClose();
      } catch (error) {
        setFormError(
          error instanceof Error ? error.message : 'Could not complete that transfer.',
        );
      }
      return;
    }

    if (!walletId) {
      setFormError('Create a wallet before recording a transaction.');
      return;
    }

    setFormError(null);
    try {
      await onSubmit({
        kind: 'transaction',
        walletId,
        type: mode,
        amount,
        category: category.trim() || 'General',
        note: note.trim().length > 0 ? note.trim() : null,
        date: date.toISOString(),
      });
      onClose();
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : 'Could not save that transaction.',
      );
    }
  };

  const accent = isTransfer
    ? 'var(--primary)'
    : mode === 'INCOME'
      ? 'var(--income)'
      : 'var(--expense)';

  // The submit button states the direction in colour as well as in words.
  const submitClass = isTransfer
    ? 'btn btn-primary'
    : mode === 'INCOME'
      ? 'btn btn-income'
      : 'btn btn-expense';

  const modes: Array<[DialogMode, string]> = isEditing
    ? [
        ['EXPENSE', 'Money out'],
        ['INCOME', 'Money in'],
      ]
    : [
        ['EXPENSE', 'Money out'],
        ['INCOME', 'Money in'],
        ['TRANSFER', 'Transfer'],
      ];

  const title = isEditing
    ? 'Edit transaction'
    : isTransfer
      ? 'New transfer'
      : 'New transaction';

  const destinationOptions = wallets.filter((wallet) => wallet.id !== walletId);

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
        aria-labelledby="tx-dialog-title"
        onSubmit={handleSubmit}
      >
        <div className="dialog-head">
          <h2 className="dialog-title" id="tx-dialog-title">
            {title}
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

        <div className="segmented">
          {modes.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => handleModeChange(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {isEditing ? (
          <p className="dialog-note">
            Changing the amount or type moves the wallet balance by the difference.
          </p>
        ) : null}

        <label className="label" htmlFor="tx-amount">
          Amount
        </label>
        <div className="amount-row" style={{ borderColor: accent }}>
          <span className="currency" style={{ color: accent }}>
            {selectedWallet?.currency ?? 'MMK'}
          </span>
          <input
            id="tx-amount"
            ref={amountRef}
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            placeholder="0"
            inputMode="decimal"
            autoComplete="off"
          />
        </div>

        {selectedWallet && !isTransfer ? (
          <p className="field-hint">
            Current balance{' '}
            {formatCurrency(selectedWallet.balance, selectedWallet.currency)}
          </p>
        ) : null}
        {isTransfer && selectedWallet && destinationWallet ? (
          <p className="field-hint">
            {formatCurrency(selectedWallet.balance, selectedWallet.currency)} →{' '}
            {formatCurrency(destinationWallet.balance, destinationWallet.currency)}
          </p>
        ) : null}

        <span className="label">{isTransfer ? 'From wallet' : 'Wallet'}</span>
        <div className="chip-row">
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              type="button"
              className="chip"
              aria-pressed={wallet.id === walletId}
              onClick={() => setWalletId(wallet.id)}
            >
              {wallet.name}
            </button>
          ))}
        </div>

        {isTransfer ? (
          <>
            <span className="label">To wallet</span>
            {destinationOptions.length === 0 ? (
              <p className="field-hint">
                You need a second wallet to transfer into.
              </p>
            ) : (
              <div className="chip-row">
                {destinationOptions.map((wallet) => (
                  <button
                    key={wallet.id}
                    type="button"
                    className="chip"
                    aria-pressed={wallet.id === toWalletId}
                    onClick={() => setToWalletId(wallet.id)}
                  >
                    {wallet.name} · {wallet.currency}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <span className="label">Category</span>
            <div className="chip-row">
              {categories.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="chip"
                  aria-pressed={option === category}
                  onClick={() => setCategory(option)}
                >
                  {/* Same hue the category carries in the ledger and filters. */}
                  <span
                    className="chip-dot"
                    style={categoryStyle(option)}
                    aria-hidden="true"
                  />
                  {option}
                </button>
              ))}
            </div>
            <input
              className="input"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Or type your own"
              maxLength={60}
            />
          </>
        )}

        <span className="label">Date</span>
        <div className="chip-row">
          {(
            [
              ['today', 'Today'],
              ['yesterday', 'Yesterday'],
              ['custom', 'Pick a date'],
            ] as Array<[DatePreset, string]>
          ).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              className="chip"
              aria-pressed={datePreset === preset}
              onClick={() => setDatePreset(preset)}
            >
              {label}
            </button>
          ))}
        </div>
        {datePreset === 'custom' ? (
          <input
            className="input"
            value={customDate}
            onChange={(event) => setCustomDate(event.target.value)}
            placeholder="YYYY-MM-DD"
            maxLength={10}
          />
        ) : null}

        <label className="label" htmlFor="tx-note">
          Note (optional)
        </label>
        <textarea
          id="tx-note"
          className="textarea"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What was this for?"
          maxLength={500}
        />

        {formError ? (
          <p className="field-error">
            <IconAlert size={15} />
            {formError}
          </p>
        ) : null}

        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className={submitClass} disabled={submitting}>
            {submitting ? (
              <span className="spinner" aria-hidden="true" />
            ) : isEditing ? (
              'Save changes'
            ) : isTransfer ? (
              'Move money'
            ) : (
              `Save ${mode === 'INCOME' ? 'income' : 'expense'}`
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
