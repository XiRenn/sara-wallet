import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  addMonths,
  ALL_CATEGORIES,
  formatCurrency,
  formatDate,
  hasLedgerFilters,
  parseAmount,
  SUPPORTED_CURRENCIES,
  toMonthKey,
  type CategoryBreakdownEntry,
  type CreateWalletInput,
  type LedgerControls,
  type MonthlySummary,
  type Transaction,
  type TransactionType,
  type UpdateWalletInput,
  type Wallet,
  type WalletTotals,
} from '@wallet/shared';

import { TransactionRow } from '../components/TransactionRow';
import { WalletCard } from '../components/WalletCard';
import { colors, fontSize, fontWeight, radii, shadow, spacing } from '../theme';

/** `null` means "no direction filter" rather than "unknown direction". */
const TYPE_FILTERS: ReadonlyArray<{ label: string; value: TransactionType | null }> = [
  { label: 'All', value: null },
  { label: 'Money in', value: 'INCOME' },
  { label: 'Money out', value: 'EXPENSE' },
];

interface WalletDashboardScreenProps {
  wallets: Wallet[];
  totals: WalletTotals;
  transactions: Transaction[];
  summary: MonthlySummary | null;
  breakdown: CategoryBreakdownEntry[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Month / scope / search / type / category — see `LedgerControls`. */
  ledger: LedgerControls;
  onLedgerChange: (patch: Partial<LedgerControls>) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  selectedWalletId: string | null;
  onSelectWallet: (walletId: string | null) => void;
  onRefresh: () => void;
  onDeleteTransaction: (transaction: Transaction) => void;
  onEditTransaction: (transaction: Transaction) => void;
  onCreateWallet: (input: CreateWalletInput) => Promise<void>;
  onUpdateWallet: (walletId: string, patch: UpdateWalletInput) => Promise<void>;
  onDeleteWallet: (wallet: Wallet) => void;
  onAddTransactionPress: () => void;
}

export function WalletDashboardScreen({
  wallets,
  totals,
  transactions,
  summary,
  breakdown,
  loading,
  refreshing,
  error,
  ledger,
  onLedgerChange,
  hasMore,
  isLoadingMore,
  onLoadMore,
  selectedWalletId,
  onSelectWallet,
  onRefresh,
  onDeleteTransaction,
  onEditTransaction,
  onCreateWallet,
  onUpdateWallet,
  onDeleteWallet,
  onAddTransactionPress,
}: WalletDashboardScreenProps) {
  const [showWalletForm, setShowWalletForm] = useState(false);
  /** Non-null while the wallet form is editing an existing wallet. */
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null);
  const [newWalletName, setNewWalletName] = useState('');
  const [newWalletCurrency, setNewWalletCurrency] = useState('MMK');
  const [newWalletOpening, setNewWalletOpening] = useState('');
  const [walletFormError, setWalletFormError] = useState<string | null>(null);
  const [creatingWallet, setCreatingWallet] = useState(false);

  const walletsById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, wallet])),
    [wallets],
  );

  const activeCurrency =
    (selectedWalletId ? walletsById.get(selectedWalletId)?.currency : null) ??
    totals.byCurrency[0]?.currency ??
    'MMK';

  const monthLabel = formatDate(ledger.month, 'month');
  // Nothing to see in the future — the ledger has no rows there.
  const canGoForward = toMonthKey(ledger.month) < toMonthKey(new Date());
  const filtersActive = hasLedgerFilters(ledger);

  const closeWalletForm = () => {
    setShowWalletForm(false);
    setEditingWalletId(null);
    setNewWalletName('');
    setNewWalletOpening('');
    setWalletFormError(null);
  };

  /** Creates a wallet, or renames the one being edited. */
  const handleWalletFormSubmit = async () => {
    const name = newWalletName.trim();
    if (name.length === 0) {
      setWalletFormError('Give the wallet a name.');
      return;
    }

    // Opening balance only makes sense at creation — afterwards the balance is
    // owned by the transaction ledger.
    let openingBalance = 0;
    if (editingWalletId === null) {
      const openingText = newWalletOpening.trim();
      if (openingText.length > 0) {
        const parsed = parseAmount(openingText);
        if (parsed === null) {
          setWalletFormError('Opening balance must be a number.');
          return;
        }
        openingBalance = parsed;
      }
    }

    setWalletFormError(null);
    setCreatingWallet(true);
    try {
      if (editingWalletId) {
        await onUpdateWallet(editingWalletId, {
          name,
          currency: newWalletCurrency,
        });
      } else {
        await onCreateWallet({ name, currency: newWalletCurrency, openingBalance });
      }
      closeWalletForm();
    } catch (cause) {
      setWalletFormError(
        cause instanceof Error ? cause.message : 'Could not save that wallet.',
      );
    } finally {
      setCreatingWallet(false);
    }
  };

  /** Long-press on a wallet tile opens its actions. */
  const handleWalletLongPress = (wallet: Wallet) => {
    Alert.alert(wallet.name, `Balance ${formatCurrency(wallet.balance, wallet.currency)}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Rename',
        onPress: () => {
          setEditingWalletId(wallet.id);
          setNewWalletName(wallet.name);
          setNewWalletCurrency(wallet.currency);
          setNewWalletOpening('');
          setWalletFormError(null);
          setShowWalletForm(true);
        },
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          Alert.alert(
            'Delete this wallet?',
            `Every transaction inside "${wallet.name}" will be deleted too. This cannot be undone.`,
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete wallet',
                style: 'destructive',
                onPress: () => onDeleteWallet(wallet),
              },
            ],
          ),
      },
    ]);
  };

  const confirmDeleteTransaction = (transaction: Transaction) => {
    const isTransfer = transaction.transfer_group_id !== null;
    Alert.alert(
      isTransfer ? 'Delete this transfer?' : 'Delete transaction?',
      isTransfer
        ? 'Both sides of the transfer will be removed and the two wallets will go back to their previous balances.'
        : `${transaction.category} · ${formatCurrency(transaction.amount, activeCurrency)}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => onDeleteTransaction(transaction),
        },
      ],
    );
  };

  const header = (
    <View>
      {/* Total balance ---------------------------------------------------- */}
      <View style={styles.totalCard}>
        <Text style={styles.totalLabel}>
          {selectedWalletId
            ? `${walletsById.get(selectedWalletId)?.name ?? 'Wallet'} balance`
            : 'Total balance'}
        </Text>
        <Text style={styles.totalAmount}>
          {formatCurrency(
            selectedWalletId
              ? (walletsById.get(selectedWalletId)?.balance ?? 0)
              : totals.totalBalance,
            activeCurrency,
          )}
        </Text>
        <Text style={styles.totalMeta}>
          {totals.walletCount} wallet{totals.walletCount === 1 ? '' : 's'}
          {totals.byCurrency.length > 1
            ? ` · ${totals.byCurrency
                .map((entry) => formatCurrency(entry.balance, entry.currency))
                .join(' + ')}`
            : ''}
        </Text>
      </View>

      {/* Monthly summary -------------------------------------------------- */}
      <View style={styles.summaryRow}>
        <View style={[styles.summaryTile, styles.summaryTileIncome]}>
          <Text style={styles.summaryLabel}>In · {monthLabel}</Text>
          <Text style={[styles.summaryAmount, { color: colors.income }]}>
            {formatCurrency(summary?.income ?? 0, activeCurrency)}
          </Text>
        </View>
        <View style={[styles.summaryTile, styles.summaryTileExpense]}>
          <Text style={styles.summaryLabel}>Out · {monthLabel}</Text>
          <Text style={[styles.summaryAmount, { color: colors.expense }]}>
            {formatCurrency(summary?.expense ?? 0, activeCurrency)}
          </Text>
        </View>
      </View>

      {(summary?.transferVolume ?? 0) > 0 ? (
        <Text style={styles.transferNote}>
          ⇄ {formatCurrency(summary?.transferVolume ?? 0, activeCurrency)} moved between
          your own wallets — not counted as income or spending.
        </Text>
      ) : null}

      {/* Category breakdown ----------------------------------------------- */}
      {breakdown.length > 0 ? (
        <>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Where it went</Text>
            <Text style={styles.sectionMeta}>{monthLabel}</Text>
          </View>
          <View style={styles.breakdownCard}>
            {breakdown.slice(0, 5).map((entry) => (
              <View key={entry.category} style={styles.breakdownRow}>
                <View style={styles.breakdownTop}>
                  <Text numberOfLines={1} style={styles.breakdownCategory}>
                    {entry.category}
                  </Text>
                  <Text style={styles.breakdownAmount}>
                    {formatCurrency(entry.total, activeCurrency)}
                  </Text>
                </View>
                <View style={styles.breakdownTrack}>
                  <View
                    style={[
                      styles.breakdownBar,
                      { width: `${Math.max(4, Math.round(entry.share * 100))}%` },
                    ]}
                  />
                </View>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {/* Wallets ---------------------------------------------------------- */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Wallets</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (showWalletForm) {
              closeWalletForm();
              return;
            }
            setEditingWalletId(null);
            setNewWalletName('');
            setNewWalletOpening('');
            setNewWalletCurrency('MMK');
            setWalletFormError(null);
            setShowWalletForm(true);
          }}
          style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
        >
          <Text style={styles.linkText}>
            {showWalletForm ? 'Cancel' : '+ New wallet'}
          </Text>
        </Pressable>
      </View>

      {showWalletForm ? (
        <View style={styles.walletForm}>
          <Text style={styles.formTitle}>
            {editingWalletId ? 'Rename wallet' : 'New wallet'}
          </Text>
          <TextInput
            value={newWalletName}
            onChangeText={setNewWalletName}
            placeholder="Wallet name (e.g. KBZ Pay)"
            placeholderTextColor={colors.textFaint}
            maxLength={80}
            style={styles.input}
          />

          {editingWalletId === null ? (
            <>
              <TextInput
                value={newWalletOpening}
                onChangeText={setNewWalletOpening}
                placeholder="Opening balance (optional)"
                placeholderTextColor={colors.textFaint}
                keyboardType="decimal-pad"
                inputMode="decimal"
                style={styles.input}
              />
              <View style={styles.chipRow}>
                {SUPPORTED_CURRENCIES.slice(0, 6).map((code) => {
                  const active = code === newWalletCurrency;
                  return (
                    <Pressable
                      key={code}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => setNewWalletCurrency(code)}
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
          ) : (
            // Currency is fixed once a wallet exists — changing it would
            // reinterpret the stored balance. The database enforces this too.
            <Text style={styles.helper}>
              Currency stays {newWalletCurrency}. Create a new wallet to use a
              different one.
            </Text>
          )}

          {walletFormError ? <Text style={styles.error}>{walletFormError}</Text> : null}
          <Pressable
            accessibilityRole="button"
            disabled={creatingWallet}
            onPress={handleWalletFormSubmit}
            style={({ pressed }) => [
              styles.primaryButton,
              (pressed || creatingWallet) && styles.pressed,
            ]}
          >
            {creatingWallet ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {editingWalletId ? 'Save name' : 'Create wallet'}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}

      {wallets.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.walletStrip}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: selectedWalletId === null }}
            onPress={() => onSelectWallet(null)}
            style={[
              styles.allWalletsCard,
              selectedWalletId === null && styles.allWalletsCardActive,
            ]}
          >
            <Text style={styles.allWalletsTitle}>All wallets</Text>
            <Text style={styles.allWalletsAmount}>
              {formatCurrency(totals.totalBalance, activeCurrency)}
            </Text>
            <Text style={styles.allWalletsFootnote}>Combined</Text>
          </Pressable>

          {wallets.map((wallet) => (
            <WalletCard
              key={wallet.id}
              wallet={wallet}
              selected={wallet.id === selectedWalletId}
              onPress={() => onSelectWallet(wallet.id)}
              onLongPress={handleWalletLongPress}
            />
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.emptyHint}>
          No wallets yet — tap “+ New wallet” to create your first one.
        </Text>
      )}

      {wallets.length > 0 ? (
        <Text style={styles.stripHint}>Long-press a wallet to rename or delete it.</Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* Ledger controls --------------------------------------------------- */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Activity</Text>
        <Text style={styles.sectionMeta}>
          {selectedWalletId ? 'This wallet' : 'All wallets'} ·{' '}
          {transactions.length}
          {hasMore ? '+' : ''} shown
        </Text>
      </View>

      <View style={styles.ledgerControls}>
        {/* Month stepper. The summary tiles and the breakdown follow it too. */}
        <View style={styles.monthRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            onPress={() => onLedgerChange({ month: addMonths(ledger.month, -1) })}
            style={({ pressed }) => [styles.monthButton, pressed && styles.pressed]}
          >
            <Text style={styles.monthArrow}>‹</Text>
          </Pressable>

          <Text style={styles.monthLabel}>{monthLabel}</Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next month"
            accessibilityState={{ disabled: !canGoForward }}
            disabled={!canGoForward}
            onPress={() => onLedgerChange({ month: addMonths(ledger.month, 1) })}
            style={({ pressed }) => [styles.monthButton, pressed && styles.pressed]}
          >
            <Text style={[styles.monthArrow, !canGoForward && styles.monthArrowDisabled]}>
              ›
            </Text>
          </Pressable>

          <View style={styles.flex} />

          {/* When on, the list ignores the month and pages through everything. */}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: ledger.scope === 'all' }}
            onPress={() =>
              onLedgerChange({ scope: ledger.scope === 'all' ? 'month' : 'all' })
            }
            style={[styles.chip, ledger.scope === 'all' && styles.chipActive]}
          >
            <Text
              style={[styles.chipText, ledger.scope === 'all' && styles.chipTextActive]}
            >
              All time
            </Text>
          </Pressable>
        </View>

        <TextInput
          value={ledger.search}
          onChangeText={(search) => onLedgerChange({ search })}
          placeholder="Search notes and categories"
          placeholderTextColor={colors.textFaint}
          maxLength={80}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={styles.input}
        />

        <View style={styles.chipRow}>
          {TYPE_FILTERS.map((option) => {
            const active = ledger.type === option.value;
            return (
              <Pressable
                key={option.label}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => onLedgerChange({ type: option.value })}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterStrip}
        >
          {ALL_CATEGORIES.map((option) => {
            const active = ledger.category === option;
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                // Tapping the active chip clears it, so the row is its own
                // off switch rather than needing a separate "Any" chip.
                onPress={() => onLedgerChange({ category: active ? null : option })}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {filtersActive ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onLedgerChange({ search: '', type: null, category: null })}
            style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
          >
            <Text style={styles.linkText}>Clear filters</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.flex}>
      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TransactionRow
            transaction={item}
            wallet={walletsById.get(item.wallet_id)}
            counterpartWallet={
              item.transfer_counterpart_wallet_id === null
                ? undefined
                : walletsById.get(item.transfer_counterpart_wallet_id)
            }
            // Transfer legs are edited as a pair in the database, never singly.
            onPress={item.transfer_group_id === null ? onEditTransaction : undefined}
            onLongPress={confirmDeleteTransaction}
          />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.loader} color={colors.primary} />
          ) : (
            <Text style={styles.emptyHint}>
              {filtersActive
                ? 'Nothing matches those filters.'
                : ledger.scope === 'all'
                  ? 'Nothing recorded yet. Tap the + button to add your first transaction.'
                  : `Nothing recorded in ${monthLabel}.`}
            </Text>
          )
        }
        ListFooterComponent={
          transactions.length === 0 ? null : isLoadingMore ? (
            <ActivityIndicator style={styles.loader} color={colors.primary} />
          ) : hasMore ? (
            <Pressable
              accessibilityRole="button"
              onPress={onLoadMore}
              style={({ pressed }) => [styles.loadMoreButton, pressed && styles.pressed]}
            >
              <Text style={styles.linkText}>Load more</Text>
            </Pressable>
          ) : (
            <Text style={styles.footerHint}>
              That is the whole ledger — {transactions.length} transaction
              {transactions.length === 1 ? '' : 's'}.
            </Text>
          )
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.listContent}
        // Fires as the end of the list comes into view. `loadMore` is a no-op
        // when a page is already in flight or the ledger is exhausted.
        onEndReached={onLoadMore}
        onEndReachedThreshold={0.4}
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
        accessibilityLabel="Add transaction"
        onPress={onAddTransactionPress}
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
  totalCard: {
    marginHorizontal: spacing.lg,
    padding: spacing.xl,
    borderRadius: radii.lg,
    backgroundColor: colors.primary,
    ...shadow.card,
  },
  totalLabel: {
    fontSize: fontSize.sm,
    color: 'rgba(255,255,255,0.82)',
    fontWeight: fontWeight.medium,
  },
  totalAmount: {
    marginTop: spacing.sm,
    fontSize: fontSize.display,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
    fontVariant: ['tabular-nums'],
  },
  totalMeta: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    color: 'rgba(255,255,255,0.75)',
  },
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  summaryTile: {
    flex: 1,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  summaryTileIncome: {
    backgroundColor: colors.incomeSoft,
    borderColor: 'rgba(217,45,32,0.18)',
  },
  summaryTileExpense: {
    backgroundColor: colors.expenseSoft,
    borderColor: 'rgba(7,148,85,0.18)',
  },
  summaryLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summaryAmount: {
    marginTop: spacing.sm,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    fontVariant: ['tabular-nums'],
  },
  transferNote: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  breakdownCard: {
    marginHorizontal: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.md,
  },
  breakdownRow: {
    gap: spacing.xs,
  },
  breakdownTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  breakdownCategory: {
    flex: 1,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text,
  },
  breakdownAmount: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  breakdownTrack: {
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSunken,
    overflow: 'hidden',
  },
  breakdownBar: {
    height: '100%',
    borderRadius: radii.pill,
    backgroundColor: colors.primary,
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
  linkButton: {
    paddingVertical: spacing.xs,
  },
  linkText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
  },
  walletStrip: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  stripHint: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  allWalletsCard: {
    width: 150,
    marginRight: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
  },
  allWalletsCardActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  allWalletsTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  allWalletsAmount: {
    marginTop: spacing.md,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  allWalletsFootnote: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  walletForm: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  formTitle: {
    marginBottom: spacing.md,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  helper: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  input: {
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: fontSize.md,
    color: colors.text,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
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
  primaryButton: {
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  primaryButtonText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
  },
  error: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    fontSize: fontSize.sm,
    color: colors.danger,
  },
  emptyHint: {
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    fontSize: fontSize.sm,
    color: colors.textFaint,
    textAlign: 'center',
  },
  loader: {
    paddingVertical: spacing.xl,
  },
  ledgerControls: {
    marginHorizontal: spacing.lg,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  monthButton: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  monthArrow: {
    fontSize: 20,
    lineHeight: 22,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  monthArrowDisabled: {
    color: colors.textFaint,
  },
  monthLabel: {
    minWidth: 92,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  filterStrip: {
    gap: spacing.sm,
    paddingRight: spacing.sm,
  },
  loadMoreButton: {
    alignSelf: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  footerHint: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.xs,
    color: colors.textFaint,
    textAlign: 'center',
  },
  separator: {
    height: 1,
    marginLeft: spacing.lg + 52,
    backgroundColor: colors.border,
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
  fabPressed: {
    backgroundColor: colors.primaryPressed,
  },
  fabGlyph: {
    fontSize: 32,
    lineHeight: 34,
    color: colors.textInverse,
    fontWeight: fontWeight.regular,
  },
});
