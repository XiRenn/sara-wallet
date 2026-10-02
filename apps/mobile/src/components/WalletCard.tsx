import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatCurrency, type Wallet } from '@wallet/shared';

import { colors, fontSize, fontWeight, radii, shadow, spacing } from '../theme';

interface WalletCardProps {
  wallet: Wallet;
  selected?: boolean;
  onPress?: (wallet: Wallet) => void;
  /** Long-press opens the wallet actions (rename / delete). */
  onLongPress?: (wallet: Wallet) => void;
}

/**
 * A single wallet tile. Renders inside the horizontal carousel on the
 * dashboard, so it has a fixed width and no vertical margin.
 */
export function WalletCard({
  wallet,
  selected = false,
  onPress,
  onLongPress,
}: WalletCardProps) {
  const isNegative = wallet.balance < 0;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${wallet.name}, balance ${formatCurrency(wallet.balance, wallet.currency)}`}
      accessibilityState={{ selected }}
      accessibilityHint="Long press for wallet options"
      onPress={() => onPress?.(wallet)}
      onLongPress={() => onLongPress?.(wallet)}
      delayLongPress={400}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        pressed && styles.cardPressed,
      ]}
    >
      <View style={styles.header}>
        <Text numberOfLines={1} style={styles.name}>
          {wallet.name}
        </Text>
        <View style={styles.currencyPill}>
          <Text style={styles.currencyText}>{wallet.currency}</Text>
        </View>
      </View>

      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        style={[styles.balance, isNegative && styles.balanceNegative]}
      >
        {formatCurrency(wallet.balance, wallet.currency)}
      </Text>

      <Text style={styles.footnote}>
        {isNegative ? 'Overdrawn' : 'Available balance'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 210,
    marginRight: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  cardPressed: {
    opacity: 0.85,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  name: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  currencyPill: {
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
  },
  currencyText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
  balance: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  balanceNegative: {
    color: colors.danger,
  },
  footnote: {
    marginTop: spacing.xs,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
});
