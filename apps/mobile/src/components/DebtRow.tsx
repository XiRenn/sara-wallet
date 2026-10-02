/**
 * One debt in the list.
 *
 * Presentational: it renders what it is handed and calls back for anything that
 * changes state.
 *
 * Two presentation rules it exists to enforce, both lifted from the desktop
 * panel so the two apps cannot drift:
 *
 *   1. **A debt is never coloured red or green.** Those two tokens mean "money
 *      came in" and "money went out" everywhere else in the app, and an unpaid
 *      debt is neither — nothing has moved yet. Direction is stated in words
 *      instead. The only red on the row is the overdue badge, which means
 *      "late", not "income".
 *   2. **Settled and closed are shown differently.** A settled debt is a
 *      receipt; a closed one is an admission that it will not be paid.
 *      Collapsing them would hide which of the two happened — so they get
 *      different words and different colours, and the settled one is blue
 *      (neutral, "done") rather than green ("money in").
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  debtProgress,
  debtStatus,
  daysUntilDue,
  formatCurrency,
  type Debt,
} from '@wallet/shared';

import { categoryColors, colors, fontSize, fontWeight, radii, spacing } from '../theme';

interface DebtRowProps {
  debt: Debt;
  /** Tapping the row opens it for editing — the common non-settle action. */
  onPress: (debt: Debt) => void;
  /**
   * Long-press opens the destructive menu (close / reopen / delete).
   *
   * It is a long-press rather than a tap because Android's `Alert` renders at
   * most three buttons, so the menu has to be short — and because the
   * dashboard already teaches "long-press a card to act on it".
   */
  onLongPress: (debt: Debt) => void;
  /** Only offered while the debt is still open — see `isDone` below. */
  onSettle: (debt: Debt) => void;
}

/** The plain-English reading of a due date, which is what the user wants. */
export function duePhrase(debt: Debt): string {
  const days = daysUntilDue(debt.due_on);
  if (days === null) return 'No due date';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days > 0) return `Due in ${days} days`;
  const late = Math.abs(days);
  return late === 1 ? '1 day overdue' : `${late} days overdue`;
}

export function directionLabel(debt: Debt): string {
  return debt.direction === 'RECEIVABLE' ? 'Owed to you' : 'You owe';
}

type BadgeTone = 'overdue' | 'soon' | 'settled' | 'closed';

function statusBadge(debt: Debt): { label: string; tone: BadgeTone } | null {
  switch (debtStatus(debt)) {
    case 'OVERDUE':
      return { label: 'Overdue', tone: 'overdue' };
    case 'DUE_SOON':
      return { label: 'Due soon', tone: 'soon' };
    case 'SETTLED':
      return { label: 'Settled', tone: 'settled' };
    case 'CLOSED':
      return { label: 'Closed', tone: 'closed' };
    default:
      return null;
  }
}

/**
 * Resolved with a switch rather than `styles[`badge_${tone}`]` so the styles
 * object stays statically indexable — a computed key would need a cast.
 */
function badgeTone(tone: BadgeTone) {
  switch (tone) {
    case 'overdue':
      return { container: styles.badgeOverdue, text: styles.badgeTextOverdue };
    case 'soon':
      return { container: styles.badgeSoon, text: styles.badgeTextSoon };
    case 'settled':
      return { container: styles.badgeSettled, text: styles.badgeTextSettled };
    default:
      return { container: styles.badgeClosed, text: styles.badgeTextClosed };
  }
}

export function DebtRow({ debt, onPress, onLongPress, onSettle }: DebtRowProps) {
  const status = debtStatus(debt);
  const progress = debtProgress(debt);
  const badge = statusBadge(debt);
  const tone = badge?.tone ?? 'closed';
  const avatarColors = categoryColors(debt.counterparty);

  /**
   * A settled or closed debt accepts no further settlements — the trigger
   * refuses them — so the Settle button would be an action that cannot succeed.
   */
  const isDone = status === 'SETTLED' || status === 'CLOSED';

  const meta = isDone
    ? status === 'CLOSED'
      ? 'Closed — no longer counted'
      : 'Paid in full'
    : duePhrase(debt);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${debt.counterparty}, ${directionLabel(debt)}, ${
        isDone ? meta : `${meta}, ${formatCurrency(debt.outstanding, debt.currency)} outstanding`
      }`}
      onPress={() => onPress(debt)}
      onLongPress={() => onLongPress(debt)}
      style={({ pressed }) => [
        styles.row,
        status === 'OVERDUE' && styles.rowOverdue,
        isDone && styles.rowDone,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.avatar, { backgroundColor: avatarColors.background }]}>
        <Text style={[styles.avatarText, { color: avatarColors.text }]}>
          {debt.counterparty.trim().charAt(0).toUpperCase() || '?'}
        </Text>
      </View>

      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.name, isDone && styles.nameDone]}>
            {debt.counterparty}
          </Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{directionLabel(debt)}</Text>
          </View>
          {badge ? (
            <View style={[styles.badge, badgeTone(tone).container]}>
              <Text style={[styles.badgeText, badgeTone(tone).text]}>{badge.label}</Text>
            </View>
          ) : null}
        </View>

        <Text numberOfLines={1} style={styles.meta}>
          {meta}
          {debt.due_on && !isDone ? ` · ${debt.due_on}` : ''}
          {debt.note ? ` · ${debt.note}` : ''}
        </Text>

        {isDone ? null : (
          <View style={styles.progressRow}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.round(progress * 100)}%` }]} />
            </View>
            <Text style={styles.progressLabel}>
              {debt.settled > 0
                ? `${formatCurrency(debt.settled, debt.currency)} of ${formatCurrency(
                    debt.principal,
                    debt.currency,
                  )}`
                : `${formatCurrency(debt.principal, debt.currency)} total`}
            </Text>
          </View>
        )}

        <View style={styles.figuresRow}>
          <View>
            <Text style={styles.outstanding}>
              {formatCurrency(isDone ? 0 : debt.outstanding, debt.currency)}
            </Text>
            <Text style={styles.outstandingLabel}>
              {isDone ? 'Nothing owed' : 'Outstanding'}
            </Text>
          </View>

          {isDone ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Settle the debt with ${debt.counterparty}`}
              onPress={() => onSettle(debt)}
              style={({ pressed }) => [styles.settleButton, pressed && styles.pressed]}
            >
              <Text style={styles.settleText}>Settle</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowOverdue: {
    borderColor: colors.danger,
  },
  rowDone: {
    backgroundColor: colors.surfaceMuted,
  },
  pressed: { opacity: 0.75 },

  avatar: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },

  body: { flex: 1, gap: spacing.xs },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  name: {
    maxWidth: '100%',
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  nameDone: {
    color: colors.textMuted,
  },

  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSunken,
  },
  badgeOverdue: { backgroundColor: colors.dangerSoft },
  badgeSoon: { backgroundColor: colors.warningSoft },
  badgeSettled: { backgroundColor: colors.primarySoft },
  badgeClosed: { backgroundColor: colors.surfaceSunken },
  badgeText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  badgeTextOverdue: { color: colors.danger },
  badgeTextSoon: { color: colors.warning },
  badgeTextSettled: { color: colors.primary },
  badgeTextClosed: { color: colors.textMuted },

  meta: {
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },

  progressRow: { gap: spacing.xs, marginTop: spacing.xs },
  track: {
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSunken,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
  },
  progressLabel: {
    fontSize: fontSize.xs,
    color: colors.textFaint,
    fontVariant: ['tabular-nums'],
  },

  figuresRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  outstanding: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  outstandingLabel: {
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },

  settleButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
  },
  settleText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
  },
});
