import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  formatCurrency,
  formatDate,
  type Transaction,
  type Wallet,
} from '@wallet/shared';

import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

interface TransactionRowProps {
  transaction: Transaction;
  /** Used to render the wallet name when the list spans several wallets. */
  wallet?: Wallet;
  /**
   * For a transfer leg, the wallet at the other end. Resolved by the screen
   * from `transfer_counterpart_wallet_id`, because a row only knows its own
   * wallet and half a transfer cannot say which way the money went.
   */
  counterpartWallet?: Wallet;
  /** Tap to edit. Omit for transfer legs — they are edited as a pair, not here. */
  onPress?: (transaction: Transaction) => void;
  onLongPress?: (transaction: Transaction) => void;
}

export function TransactionRow({
  transaction,
  wallet,
  counterpartWallet,
  onPress,
  onLongPress,
}: TransactionRowProps) {
  const isIncome = transaction.type === 'INCOME';
  const isTransfer = transaction.transfer_group_id !== null;
  const currency = wallet?.currency ?? 'MMK';
  const sign = isIncome ? '+' : '-';

  /**
   * One wallet for an ordinary row; both ends of a transfer, in `from → to`
   * order, so a leg reads as the movement it is rather than as a stray line
   * labelled with one wallet.
   */
  const walletLabel = (() => {
    if (wallet === undefined) return null;
    if (counterpartWallet === undefined) return wallet.name;
    return isIncome
      ? `${counterpartWallet.name} → ${wallet.name}`
      : `${wallet.name} → ${counterpartWallet.name}`;
  })();

  const accent = isTransfer ? colors.primary : isIncome ? colors.income : colors.expense;
  const avatarBackground = isTransfer
    ? colors.primarySoft
    : isIncome
      ? colors.incomeSoft
      : colors.expenseSoft;
  const glyph = isTransfer ? '⇄' : isIncome ? '↓' : '↑';

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={[
        transaction.category,
        walletLabel,
        `${sign}${formatCurrency(transaction.amount, currency)}`,
      ]
        .filter(Boolean)
        .join(', ')}
      disabled={onPress === undefined}
      onPress={() => onPress?.(transaction)}
      onLongPress={() => onLongPress?.(transaction)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={[styles.avatar, { backgroundColor: avatarBackground }]}>
        <Text style={[styles.avatarGlyph, { color: accent }]}>{glyph}</Text>
      </View>

      <View style={styles.body}>
        <Text numberOfLines={1} style={styles.category}>
          {transaction.category}
        </Text>
        <Text numberOfLines={1} style={styles.meta}>
          {[walletLabel, formatDate(transaction.date, 'short'), transaction.note]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>

      <Text numberOfLines={1} style={[styles.amount, { color: accent }]}>
        {sign}
        {formatCurrency(transaction.amount, currency)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  avatarGlyph: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    lineHeight: 22,
  },
  body: {
    flex: 1,
    marginRight: spacing.md,
  },
  category: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
    color: colors.text,
  },
  meta: {
    marginTop: 2,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  amount: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    fontVariant: ['tabular-nums'],
  },
});
