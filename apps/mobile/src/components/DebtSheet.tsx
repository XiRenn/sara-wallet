/**
 * Records a debt, or edits its descriptive fields.
 *
 * The one thing this sheet must not do is imply that money has moved. The
 * footer says so explicitly, because a form that looks like the transaction
 * sheet but writes no ledger row is a form users will misread.
 *
 * Editing is narrower than creating on purpose. Once anything has been settled,
 * the principal, currency and direction are frozen by `tg_debts_guard_edits` —
 * changing any of them would reinterpret payments that already moved real cash.
 * Rather than show fields that fail on save, the sheet shows them read-only
 * with the reason.
 *
 * The direction switch is blue, not red/green: choosing "owed to you" is not
 * money coming in, it is a note about the future.
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
  formatCurrency,
  parseAmount,
  SUPPORTED_CURRENCIES,
  toISODate,
  type CreateDebtInput,
  type Debt,
  type DebtDirection,
  type UpdateDebtInput,
} from '@wallet/shared';

import { colors, fontSize, fontWeight, radii, shadow, spacing } from '../theme';

interface DebtSheetProps {
  visible: boolean;
  /** Pass a debt to edit it. Direction, principal and currency are then fixed. */
  editing?: Debt | null;
  /** Pre-selects the currency for a new debt. */
  defaultCurrency?: string;
  submitting?: boolean;
  onClose: () => void;
  onCreate: (input: CreateDebtInput) => Promise<void>;
  onUpdate: (debtId: string, patch: UpdateDebtInput) => Promise<void>;
}

const DIRECTIONS: ReadonlyArray<{ value: DebtDirection; label: string; hint: string }> = [
  { value: 'RECEIVABLE', label: 'Owed to you', hint: 'Who owes you' },
  { value: 'PAYABLE', label: 'You owe', hint: 'Who you owe' },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function DebtSheet({
  visible,
  editing = null,
  defaultCurrency = 'MMK',
  submitting = false,
  onClose,
  onCreate,
  onUpdate,
}: DebtSheetProps) {
  const isEditing = editing !== null;

  const [direction, setDirection] = useState<DebtDirection>('RECEIVABLE');
  const [counterparty, setCounterparty] = useState('');
  const [amountText, setAmountText] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [issuedOn, setIssuedOn] = useState(toISODate(new Date()));
  const [dueOn, setDueOn] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Seed the draft every time the sheet opens, so a cancelled edit never leaks
  // into the next one.
  useEffect(() => {
    if (!visible) return;

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
  }, [visible, editing, defaultCurrency]);

  /** Editing is only locked once money has actually been posted against it. */
  const locked = isEditing && (editing?.settled ?? 0) > 0;

  const currencyOptions = useMemo(() => {
    const options = new Set<string>([currency, ...SUPPORTED_CURRENCIES.slice(0, 6)]);
    return Array.from(options);
  }, [currency]);

  const activeDirection = DIRECTIONS.find((entry) => entry.value === direction) ?? DIRECTIONS[0]!;

  const handleSubmit = async () => {
    const name = counterparty.trim();
    if (name.length === 0) {
      setFormError('Who is this with? A name or a shop is enough.');
      return;
    }

    if (dueOn.trim().length > 0 && !ISO_DATE.test(dueOn.trim())) {
      setFormError('Enter the due date as YYYY-MM-DD, or leave it blank.');
      return;
    }

    // A due date before the issue date is refused by `debts_due_after_issue`;
    // catching it here turns a constraint name into a sentence. ISO date
    // strings compare correctly as plain strings.
    const due = dueOn.trim();
    if (due.length > 0 && due < issuedOn) {
      setFormError('The due date cannot fall before the date it was recorded.');
      return;
    }

    setFormError(null);

    try {
      if (isEditing && editing) {
        await onUpdate(editing.id, {
          counterparty: name,
          note: note.trim().length > 0 ? note.trim() : null,
          dueOn: due.length > 0 ? due : null,
        });
        onClose();
        return;
      }

      const parsed = parseAmount(amountText);
      if (parsed === null || parsed <= 0) {
        setFormError('Enter an amount greater than zero.');
        return;
      }

      await onCreate({
        direction,
        counterparty: name,
        principal: parsed,
        currency,
        issuedOn,
        dueOn: due.length > 0 ? due : null,
        note: note.trim().length > 0 ? note.trim() : null,
      });
      onClose();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Could not save that debt.');
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
              <Text style={styles.title}>{isEditing ? 'Edit debt' : 'Record a debt'}</Text>
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
              {locked ? (
                <Text style={styles.notice}>
                  {formatCurrency(editing?.settled ?? 0, currency)} has already been settled
                  against this, so the direction, amount and currency are fixed. Delete it and
                  record a new one to change those.
                </Text>
              ) : null}

              {isEditing ? null : (
                <View style={styles.segmented}>
                  {DIRECTIONS.map((entry) => {
                    const active = direction === entry.value;
                    return (
                      <Pressable
                        key={entry.value}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        onPress={() => setDirection(entry.value)}
                        style={[styles.segment, active && styles.segmentActive]}
                      >
                        <Text
                          style={[styles.segmentText, active && styles.segmentTextActive]}
                        >
                          {entry.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              <Text style={styles.label}>{activeDirection.hint}</Text>
              <TextInput
                value={counterparty}
                onChangeText={setCounterparty}
                placeholder="A person, a shop, an institution"
                placeholderTextColor={colors.textFaint}
                maxLength={80}
                style={styles.input}
              />

              <Text style={styles.label}>Amount</Text>
              <View style={[styles.amountBox, locked && styles.amountBoxLocked]}>
                <Text style={styles.amountPrefix}>{currency}</Text>
                <TextInput
                  value={amountText}
                  onChangeText={setAmountText}
                  placeholder="0"
                  placeholderTextColor={colors.textFaint}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  editable={!locked}
                  style={styles.amountInput}
                />
              </View>

              {isEditing ? null : (
                <>
                  <Text style={styles.label}>Currency</Text>
                  <View style={styles.chipRow}>
                    {currencyOptions.map((code) => {
                      const active = code === currency;
                      return (
                        <Pressable
                          key={code}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          onPress={() => setCurrency(code)}
                          style={[styles.chip, active && styles.chipActive]}
                        >
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
                            {code}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}

              <Text style={styles.label}>Recorded on</Text>
              <TextInput
                value={issuedOn}
                onChangeText={setIssuedOn}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={10}
                editable={!isEditing}
                style={[styles.input, isEditing && styles.inputLocked]}
              />
              {isEditing ? (
                <Text style={styles.helper}>The date it was recorded does not change.</Text>
              ) : null}

              <Text style={styles.label}>Due on (optional)</Text>
              <TextInput
                value={dueOn}
                onChangeText={setDueOn}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={10}
                style={styles.input}
              />
              <Text style={styles.helper}>
                Leave blank if there is no agreed date — an undated debt is never counted as
                overdue.
              </Text>

              <Text style={styles.label}>Note (optional)</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="What it was for"
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
                  (pressed || submitting) && styles.submitPressed,
                ]}
              >
                {submitting ? (
                  <ActivityIndicator color={colors.textInverse} />
                ) : (
                  <Text style={styles.submitText}>
                    {isEditing ? 'Save changes' : 'Record debt'}
                  </Text>
                )}
              </Pressable>

              <Text style={styles.footerNote}>
                {isEditing
                  ? 'Editing a debt never moves money.'
                  : 'Recording a debt moves no money. Your wallets change when you settle it.'}
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
    marginBottom: spacing.sm,
  },
  title: {
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

  notice: {
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: colors.warningSoft,
    fontSize: fontSize.xs,
    lineHeight: 17,
    color: colors.warning,
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
  segmentActive: { backgroundColor: colors.primary },
  segmentText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  segmentTextActive: { color: colors.textInverse },

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
    borderColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  amountBoxLocked: { borderColor: colors.borderStrong },
  amountPrefix: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.primary,
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
  inputLocked: {
    backgroundColor: colors.surfaceMuted,
    color: colors.textMuted,
  },
  noteInput: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  helper: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    lineHeight: 16,
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

  error: {
    marginTop: spacing.md,
    fontSize: fontSize.sm,
    color: colors.danger,
  },
  submit: {
    marginTop: spacing.xl,
    paddingVertical: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
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
    color: colors.textFaint,
    textAlign: 'center',
  },
});
