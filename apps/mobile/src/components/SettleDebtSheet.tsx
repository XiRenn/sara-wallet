/**
 * Settles a debt with a real ledger row.
 *
 * This is the only place in the AP/AR flow where money moves, and the sheet is
 * built to make that obvious: the wallet is chosen explicitly, the amount is
 * capped at what is outstanding, and the footer says exactly which ledger row
 * will be written.
 *
 * Note the deliberate colour shift. A *debt* is never red or green — nothing
 * has moved yet — but a *settlement* is an ordinary income or expense, so it
 * takes the app's normal red-in / green-out. That contrast is the point: the
 * moment the button turns red or green, money is about to move.
 *
 * The wallet list is filtered to the debt's currency rather than letting the
 * user pick a mismatched one and be refused by the trigger. Cross-currency
 * settlement needs an exchange rate this app does not model, so offering the
 * option would be offering a guaranteed failure.
 */

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
  defaultSettlementCategory,
  formatCurrency,
  parseAmount,
  settlementTypeFor,
  toISODate,
  type Debt,
  type SettleDebtInput,
  type Wallet,
} from '@wallet/shared';

import { colors, fontSize, fontWeight, radii, shadow, spacing } from '../theme';

interface SettleDebtSheetProps {
  visible: boolean;
  /** The debt being settled. Null closes the sheet. */
  debt: Debt | null;
  wallets: Wallet[];
  submitting?: boolean;
  onClose: () => void;
  onSubmit: (input: SettleDebtInput) => Promise<void>;
}

type DatePreset = 'today' | 'yesterday' | 'custom';

function resolveDate(preset: DatePreset, custom: string): string | null {
  if (preset === 'today') return toISODate(new Date());
  if (preset === 'yesterday') {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return toISODate(yesterday);
  }
  const trimmed = custom.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export function SettleDebtSheet({
  visible,
  debt,
  wallets,
  submitting = false,
  onClose,
  onSubmit,
}: SettleDebtSheetProps) {
  const [amountText, setAmountText] = useState('');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  const [customDate, setCustomDate] = useState(toISODate(new Date()));
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
    if (!visible || !debt) return;
    // Defaulting to the full outstanding amount is the common case: most
    // settlements clear the debt, and the amount is the field people get wrong.
    setAmountText(String(debt.outstanding));
    setWalletId(eligibleWallets[0]?.id ?? null);
    setDatePreset('today');
    setCustomDate(toISODate(new Date()));
    setNote('');
    setFormError(null);
  }, [visible, debt, eligibleWallets]);

  // Keep the selection valid if the wallet list changes underneath us.
  useEffect(() => {
    if (walletId && eligibleWallets.some((wallet) => wallet.id === walletId)) return;
    setWalletId(eligibleWallets[0]?.id ?? null);
  }, [eligibleWallets, walletId]);

  if (!visible || !debt) return null;

  const isReceivable = debt.direction === 'RECEIVABLE';
  const type = settlementTypeFor(debt.direction);
  const category = defaultSettlementCategory(debt.direction);
  const accent = isReceivable ? colors.income : colors.expense;

  const parsed = parseAmount(amountText);
  const remaining = parsed === null ? debt.outstanding : debt.outstanding - parsed;
  const selectedWallet = eligibleWallets.find((wallet) => wallet.id === walletId) ?? null;

  const handleSubmit = async () => {
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

    const date = resolveDate(datePreset, customDate);
    if (date === null) {
      setFormError('Enter the date as YYYY-MM-DD.');
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
      onClose();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not record that settlement.');
    }
  };

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
              <Text numberOfLines={1} style={styles.title}>
                {isReceivable ? 'Collect from' : 'Pay'} {debt.counterparty}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
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
              <View style={styles.figures}>
                <View style={styles.figure}>
                  <Text style={styles.figureLabel}>Still outstanding</Text>
                  <Text style={styles.figureValue}>
                    {formatCurrency(debt.outstanding, debt.currency)}
                  </Text>
                </View>
                <View style={styles.figure}>
                  <Text style={styles.figureLabel}>Original amount</Text>
                  <Text style={styles.figureValue}>
                    {formatCurrency(debt.principal, debt.currency)}
                  </Text>
                </View>
                <View style={styles.figure}>
                  <Text style={styles.figureLabel}>After this</Text>
                  <Text style={[styles.figureValue, { color: accent }]}>
                    {formatCurrency(Math.max(0, remaining), debt.currency)}
                  </Text>
                </View>
              </View>

              <Text style={styles.label}>Amount</Text>
              <View style={[styles.amountBox, { borderColor: accent }]}>
                <Text style={[styles.amountPrefix, { color: accent }]}>{debt.currency}</Text>
                <TextInput
                  value={amountText}
                  onChangeText={setAmountText}
                  placeholder="0"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  style={styles.amountInput}
                />
              </View>
              <View style={styles.chipRow}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAmountText(String(debt.outstanding))}
                  style={[styles.chip, parsed === debt.outstanding && styles.chipActive]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      parsed === debt.outstanding && styles.chipTextActive,
                    ]}
                  >
                    Settle in full
                  </Text>
                </Pressable>
                {debt.outstanding >= 2 ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setAmountText(String(Math.round(debt.outstanding / 2)))}
                    style={styles.chip}
                  >
                    <Text style={styles.chipText}>Half</Text>
                  </Pressable>
                ) : null}
              </View>

              <Text style={styles.label}>Wallet</Text>
              {eligibleWallets.length === 0 ? (
                <Text style={styles.error}>
                  You have no {debt.currency} wallet to settle this from. Create one first —
                  settling across currencies needs an exchange rate this app does not model.
                </Text>
              ) : (
                <View style={styles.chipRow}>
                  {eligibleWallets.map((wallet) => {
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
                          {wallet.name} · {formatCurrency(wallet.balance, wallet.currency)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

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
                  style={[styles.input, styles.spacedInput]}
                />
              ) : null}

              <Text style={styles.label}>Note (optional)</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Optional"
                placeholderTextColor={colors.textFaint}
                maxLength={500}
                style={styles.input}
              />

              {formError ? <Text style={styles.error}>{formError}</Text> : null}

              <Text style={styles.footerNote}>
                This writes a real {isReceivable ? 'income' : 'expense'} of{' '}
                {formatCurrency(parsed ?? 0, debt.currency)} under “{category}”
                {selectedWallet ? ` to ${selectedWallet.name}` : ''}, and moves that wallet's
                balance.
              </Text>

              <Pressable
                accessibilityRole="button"
                disabled={submitting || eligibleWallets.length === 0}
                onPress={handleSubmit}
                style={({ pressed }) => [
                  styles.submit,
                  { backgroundColor: accent },
                  (pressed || submitting || eligibleWallets.length === 0) &&
                    styles.submitPressed,
                ]}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.textInverse} />
                ) : (
                  <Text style={styles.submitText}>
                    {isReceivable ? 'Record collection' : 'Record payment'}
                  </Text>
                )}
              </Pressable>

              <Text style={styles.typeNote}>
                Filed as a {type === 'INCOME' ? 'money-in' : 'money-out'} row, so it appears in
                your ledger like any other transaction.
              </Text>
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
  sheetWrapper: { width: '100%' },
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
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  title: {
    flex: 1,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  closeButton: { paddingHorizontal: spacing.sm },
  closeGlyph: {
    fontSize: 26,
    lineHeight: 28,
    color: colors.textMuted,
  },
  scrollContent: { paddingBottom: spacing.xl },

  figures: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
  },
  figure: { flex: 1, gap: 2 },
  figureLabel: {
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  figureValue: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
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

  input: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: fontSize.md,
    color: colors.text,
  },
  spacedInput: { marginTop: spacing.sm },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
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

  error: {
    marginTop: spacing.sm,
    fontSize: fontSize.sm,
    lineHeight: 18,
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
  submitPressed: { opacity: 0.8 },
  submitText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
  },
  footerNote: {
    marginTop: spacing.md,
    fontSize: fontSize.xs,
    lineHeight: 16,
    color: colors.textMuted,
  },
  typeNote: {
    marginTop: spacing.sm,
    fontSize: fontSize.xs,
    lineHeight: 16,
    color: colors.textFaint,
  },
});
