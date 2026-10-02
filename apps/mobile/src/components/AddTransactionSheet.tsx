import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  categoriesForType,
  formatCurrency,
  parseAmount,
  toISODate,
  type Transaction,
  type TransactionType,
  type Wallet,
} from '@wallet/shared';

import { colors, fontSize, fontWeight, radii, shadow, spacing } from '../theme';

/** The sheet can record an income, an expense, or move money between wallets. */
type SheetMode = TransactionType | 'TRANSFER';

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

interface AddTransactionSheetProps {
  visible: boolean;
  wallets: Wallet[];
  defaultWalletId?: string | null;
  submitting?: boolean;
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
 * Bottom sheet for recording or editing a transaction, or for moving money
 * between two wallets.
 *
 * Editing a transfer leg is impossible by design — the database rejects it,
 * because changing one leg would leave the pair unbalanced and the balances
 * with it. So the TRANSFER option is hidden while editing.
 */
export function AddTransactionSheet({
  visible,
  wallets,
  defaultWalletId,
  submitting = false,
  editing = null,
  onClose,
  onSubmit,
}: AddTransactionSheetProps) {
  const isEditing = editing !== null;

  const [mode, setMode] = useState<SheetMode>('EXPENSE');
  const [amountText, setAmountText] = useState('');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [toWalletId, setToWalletId] = useState<string | null>(null);
  const [category, setCategory] = useState('Food');
  const [note, setNote] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  const [customDate, setCustomDate] = useState(toISODate(new Date()));
  const [formError, setFormError] = useState<string | null>(null);

  // Seed the draft every time the sheet opens — from the transaction being
  // edited, or from scratch.
  useEffect(() => {
    if (!visible) return;

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
      setMode('EXPENSE');
      setAmountText('');
      setWalletId(defaultWalletId ?? wallets[0]?.id ?? null);
      setToWalletId(wallets.find((w) => w.id !== (defaultWalletId ?? wallets[0]?.id))?.id ?? null);
      setCategory(categoriesForType('EXPENSE')[0] as string);
      setNote('');
      setDatePreset('today');
      setCustomDate(toISODate(new Date()));
    }

    setFormError(null);
  }, [visible, editing, defaultWalletId, wallets]);

  // Keep selections valid if the wallet list changes underneath us.
  useEffect(() => {
    if (walletId && wallets.some((wallet) => wallet.id === walletId)) return;
    setWalletId(wallets[0]?.id ?? null);
  }, [wallets, walletId]);

  useEffect(() => {
    if (toWalletId && wallets.some((wallet) => wallet.id === toWalletId)) return;
    setToWalletId(wallets.find((wallet) => wallet.id !== walletId)?.id ?? null);
  }, [wallets, toWalletId, walletId]);

  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === walletId) ?? null,
    [wallets, walletId],
  );

  const destinationWallet = useMemo(
    () => wallets.find((wallet) => wallet.id === toWalletId) ?? null,
    [wallets, toWalletId],
  );

  // Transfers write their own category in the database, so the picker only
  // ever shows suggestions for a real income or expense.
  const categories = mode === 'TRANSFER' ? [] : categoriesForType(mode);

  const handleModeChange = (next: SheetMode) => {
    setMode(next);
    setFormError(null);
    if (next === 'TRANSFER') return;

    const nextCategories = categoriesForType(next);
    if (!nextCategories.includes(category)) {
      setCategory(nextCategories[0] as string);
    }
  };

  const handleSubmit = async () => {
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

    if (mode === 'TRANSFER') {
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

  const isTransfer = mode === 'TRANSFER';
  const accent = isTransfer
    ? colors.primary
    : mode === 'INCOME'
      ? colors.income
      : colors.expense;

  const modes: Array<[SheetMode, string]> = isEditing
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
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetWrapper}
        >
          <View style={styles.sheet}>
            <View style={styles.grabber} />

            <View style={styles.headerRow}>
              <Text style={styles.title}>{title}</Text>
              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                hitSlop={12}
                style={styles.closeButton}
              >
                <Text style={styles.closeGlyph}>×</Text>
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
            >
              <View style={styles.segmented}>
                {modes.map(([value, label]) => {
                  const active = mode === value;
                  const optionAccent =
                    value === 'TRANSFER'
                      ? colors.primary
                      : value === 'INCOME'
                        ? colors.income
                        : colors.expense;
                  return (
                    <Pressable
                      key={value}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => handleModeChange(value)}
                      style={[styles.segment, active && { backgroundColor: optionAccent }]}
                    >
                      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {isEditing ? (
                <Text style={styles.helper}>
                  Changing the amount or type moves the wallet balance by the difference.
                </Text>
              ) : null}

              {/* Amount ---------------------------------------------------- */}
              <Text style={styles.label}>Amount</Text>
              <View style={[styles.amountBox, { borderColor: accent }]}>
                <Text style={[styles.amountPrefix, { color: accent }]}>
                  {selectedWallet?.currency ?? 'MMK'}
                </Text>
                <TextInput
                  value={amountText}
                  onChangeText={setAmountText}
                  placeholder="0"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  style={styles.amountInput}
                  autoFocus={!isEditing}
                />
              </View>
              {selectedWallet && !isTransfer ? (
                <Text style={styles.helper}>
                  Current balance{' '}
                  {formatCurrency(selectedWallet.balance, selectedWallet.currency)}
                </Text>
              ) : null}
              {isTransfer && selectedWallet && destinationWallet ? (
                <Text style={styles.helper}>
                  {formatCurrency(selectedWallet.balance, selectedWallet.currency)} →{' '}
                  {formatCurrency(destinationWallet.balance, destinationWallet.currency)}
                </Text>
              ) : null}

              {/* From wallet ------------------------------------------------ */}
              <Text style={styles.label}>{isTransfer ? 'From wallet' : 'Wallet'}</Text>
              {wallets.length === 0 ? (
                <Text style={styles.helper}>
                  You have no wallets yet. Create one from the dashboard first.
                </Text>
              ) : (
                <View style={styles.chipRow}>
                  {wallets.map((wallet) => {
                    const active = wallet.id === walletId;
                    return (
                      <Pressable
                        key={wallet.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => setWalletId(wallet.id)}
                        style={[styles.chip, active && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>
                          {wallet.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {/* To wallet (transfers only) --------------------------------- */}
              {isTransfer ? (
                <>
                  <Text style={styles.label}>To wallet</Text>
                  {destinationOptions.length === 0 ? (
                    <Text style={styles.helper}>
                      You need a second wallet to transfer into.
                    </Text>
                  ) : (
                    <View style={styles.chipRow}>
                      {destinationOptions.map((wallet) => {
                        const active = wallet.id === toWalletId;
                        return (
                          <Pressable
                            key={wallet.id}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            onPress={() => setToWalletId(wallet.id)}
                            style={[styles.chip, active && styles.chipActive]}
                          >
                            <Text
                              style={[styles.chipText, active && styles.chipTextActive]}
                            >
                              {wallet.name} · {wallet.currency}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </>
              ) : null}

              {/* Category (not for transfers) ------------------------------- */}
              {!isTransfer ? (
                <>
                  <Text style={styles.label}>Category</Text>
                  <View style={styles.chipRow}>
                    {categories.map((option) => {
                      const active = option === category;
                      return (
                        <Pressable
                          key={option}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          onPress={() => setCategory(option)}
                          style={[styles.chip, active && styles.chipActive]}
                        >
                          <Text
                            style={[styles.chipText, active && styles.chipTextActive]}
                          >
                            {option}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <TextInput
                    value={category}
                    onChangeText={setCategory}
                    placeholder="Or type your own"
                    placeholderTextColor={colors.textFaint}
                    maxLength={60}
                    style={styles.input}
                  />
                </>
              ) : null}

              {/* Date ------------------------------------------------------- */}
              <Text style={styles.label}>Date</Text>
              <View style={styles.chipRow}>
                {(
                  [
                    ['today', 'Today'],
                    ['yesterday', 'Yesterday'],
                    ['custom', 'Pick a date'],
                  ] as Array<[DatePreset, string]>
                ).map(([preset, label]) => {
                  const active = datePreset === preset;
                  return (
                    <Pressable
                      key={preset}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => setDatePreset(preset)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {datePreset === 'custom' ? (
                <TextInput
                  value={customDate}
                  onChangeText={setCustomDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={10}
                  style={styles.input}
                />
              ) : null}

              {/* Note ------------------------------------------------------- */}
              <Text style={styles.label}>Note (optional)</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="What was this for?"
                placeholderTextColor={colors.textFaint}
                maxLength={500}
                multiline
                style={[styles.input, styles.noteInput]}
              />

              {formError ? <Text style={styles.error}>{formError}</Text> : null}

              <Pressable
                accessibilityRole="button"
                disabled={submitting}
                onPress={handleSubmit}
                style={({ pressed }) => [
                  styles.submit,
                  { backgroundColor: accent },
                  (pressed || submitting) && styles.submitPressed,
                ]}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.textInverse} />
                ) : (
                  <Text style={styles.submitText}>
                    {isEditing
                      ? 'Save changes'
                      : isTransfer
                        ? 'Move money'
                        : `Save ${mode === 'INCOME' ? 'income' : 'expense'}`}
                  </Text>
                )}
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  sheetWrapper: {
    width: '100%',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    maxHeight: '92%',
    ...shadow.card,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  closeButton: {
    paddingHorizontal: spacing.sm,
  },
  closeGlyph: {
    fontSize: 26,
    lineHeight: 28,
    color: colors.textMuted,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: 4,
    marginBottom: spacing.sm,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    alignItems: 'center',
  },
  segmentText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  segmentTextActive: {
    color: colors.textInverse,
  },
  label: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  amountBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  amountPrefix: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    marginRight: spacing.sm,
  },
  amountInput: {
    flex: 1,
    paddingVertical: spacing.md,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  helper: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.textMuted,
  },
  chipTextActive: {
    color: colors.textInverse,
    fontWeight: fontWeight.semibold,
  },
  input: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: fontSize.md,
    color: colors.text,
  },
  noteInput: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  error: {
    marginTop: spacing.md,
    fontSize: fontSize.sm,
    color: colors.danger,
  },
  submit: {
    marginTop: spacing.xl,
    paddingVertical: spacing.lg,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  submitPressed: {
    opacity: 0.8,
  },
  submitText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
  },
});
