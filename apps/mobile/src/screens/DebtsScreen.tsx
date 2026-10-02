/**
 * The Accounts Payable / Receivable view.
 *
 * Presentational, like every other screen here: the data arrives as props and
 * every action is a callback. `useDebts` in `@wallet/shared` owns the state.
 *
 * It is a sibling of `WalletDashboardScreen` rather than a section inside it.
 * The two answer different questions — "where did my money go" and "who owes
 * whom" — and folding the second into the first would have put a second
 * FlatList's worth of rows below an already long ledger.
 *
 * The summary is grouped by currency and never summed across currencies:
 * adding MMK to THB produces a number that means nothing. `get_debt_totals()`
 * groups for exactly this reason.
 */

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  formatCurrency,
  isOverdue,
  type CurrencyCode,
  type Debt,
  type DebtTotals,
  type Wallet,
} from '@wallet/shared';

import { DebtRow } from '../components/DebtRow';
import { colors, fontSize, fontWeight, radii, shadow, spacing } from '../theme';

interface DebtsScreenProps {
  debts: Debt[];
  totals: DebtTotals;
  /** Used only to decide which currency block comes first. */
  wallets: Wallet[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  onAddDebt: () => void;
  onSettle: (debt: Debt) => void;
  /** Opens the debt for editing. */
  onEdit: (debt: Debt) => void;
  /** Opens the close / reopen / delete menu. */
  onOpenActions: (debt: Debt) => void;
}

export function DebtsScreen({
  debts,
  totals,
  wallets,
  loading,
  refreshing,
  error,
  onRefresh,
  onAddDebt,
  onSettle,
  onEdit,
  onOpenActions,
}: DebtsScreenProps) {
  const activeCurrency: CurrencyCode = wallets[0]?.currency ?? 'MMK';

  /**
   * The active currency first, then the rest. A user holding MMK and THB needs
   * both totals and must not see them added together.
   */
  const currencies = useMemo(
    () =>
      [...totals.byCurrency].sort((a, b) => {
        if (a.currency === activeCurrency) return -1;
        if (b.currency === activeCurrency) return 1;
        return a.currency.localeCompare(b.currency);
      }),
    [totals.byCurrency, activeCurrency],
  );

  const overdueCount = useMemo(
    () => debts.filter((debt) => debt.closed_at === null && isOverdue(debt)).length,
    [debts],
  );

  const header = (
    <View>
      {currencies.length === 0 ? null : (
        <View style={styles.summaryBlocks}>
          {currencies.map((entry) => (
            <View key={entry.currency}>
              {currencies.length > 1 ? (
                <Text style={styles.groupLabel}>{entry.currency}</Text>
              ) : null}

              <View style={styles.summaryRow}>
                <View style={[styles.tile, styles.tileReceivable]}>
                  <Text style={styles.tileLabel}>Owed to you</Text>
                  <Text style={styles.tileValue}>
                    {formatCurrency(entry.receivableOutstanding, entry.currency)}
                  </Text>
                  <Text style={styles.tileSub}>
                    {entry.receivableOverdue > 0
                      ? `${formatCurrency(entry.receivableOverdue, entry.currency)} overdue`
                      : 'Nothing overdue'}
                  </Text>
                </View>

                <View style={[styles.tile, styles.tilePayable]}>
                  <Text style={styles.tileLabel}>You owe</Text>
                  <Text style={styles.tileValue}>
                    {formatCurrency(entry.payableOutstanding, entry.currency)}
                  </Text>
                  <Text style={styles.tileSub}>
                    {entry.payableOverdue > 0
                      ? `${formatCurrency(entry.payableOverdue, entry.currency)} overdue`
                      : 'Nothing overdue'}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      )}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Debts</Text>
        <Text style={styles.sectionMeta}>
          {debts.length === 0
            ? 'Nothing recorded'
            : `${debts.length} record${debts.length === 1 ? '' : 's'}`}
          {overdueCount > 0 ? ` · ${overdueCount} overdue` : ''}
        </Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={styles.flex}>
      <FlatList
        data={debts}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <DebtRow
            debt={item}
            onPress={onEdit}
            onLongPress={onOpenActions}
            onSettle={onSettle}
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.loader} color={colors.primary} />
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No debts recorded</Text>
              <Text style={styles.emptyBody}>
                Record money you have lent or borrowed. Nothing moves in your wallets until you
                settle it.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={onAddDebt}
                style={({ pressed }) => [styles.emptyButton, pressed && styles.pressed]}
              >
                <Text style={styles.emptyButtonText}>Record your first debt</Text>
              </Pressable>
            </View>
          )
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Record a debt"
        onPress={onAddDebt}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <Text style={styles.fabGlyph}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  listContent: {
    paddingTop: spacing.md,
    paddingBottom: 120,
  },
  pressed: { opacity: 0.75 },

  summaryBlocks: {
    paddingHorizontal: spacing.lg,
    gap: spacing.lg,
  },
  groupLabel: {
    marginBottom: spacing.sm,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  tile: {
    flex: 1,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    // A debt is never red or green. These two tiles are tinted blue and amber
    // — "owed to you" and "you owe" are directions, not money in or out.
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  tileReceivable: {
    backgroundColor: colors.primarySoft,
    borderColor: 'rgba(37,99,235,0.18)',
  },
  tilePayable: {
    backgroundColor: colors.warningSoft,
    borderColor: 'rgba(181,71,8,0.18)',
  },
  tileLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tileValue: {
    marginTop: spacing.sm,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  tileSub: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  sectionMeta: {
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },

  separator: { height: spacing.md },

  error: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    fontSize: fontSize.sm,
    color: colors.danger,
  },
  loader: { paddingVertical: spacing.xxl },

  emptyState: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.xl,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  emptyBody: {
    fontSize: fontSize.sm,
    lineHeight: 20,
    color: colors.textFaint,
    textAlign: 'center',
  },
  emptyButton: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
  },
  emptyButtonText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
  },

  fab: {
    position: 'absolute',
    right: spacing.xl,
    bottom: spacing.xl,
    width: 60,
    height: 60,
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.floating,
  },
  fabPressed: { backgroundColor: colors.primaryPressed },
  fabGlyph: {
    fontSize: 32,
    lineHeight: 34,
    color: colors.textInverse,
    fontWeight: fontWeight.regular,
  },
});
