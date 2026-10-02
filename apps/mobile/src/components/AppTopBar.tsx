/**
 * The signed-in header: who you are, and the way out.
 *
 * It lives here rather than inside `WalletDashboardScreen` because there is now
 * more than one screen behind it. Two screens each rendering their own copy of
 * the greeting is how they drift — one gains a wallet count, the other does not
 * — so the bar is rendered once by `App.tsx` and the screens start below it.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppUser } from '@wallet/shared';

import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

interface AppTopBarProps {
  user: AppUser;
  onSignOut: () => void;
}

export function AppTopBar({ user, onSignOut }: AppTopBarProps) {
  return (
    <View style={styles.bar}>
      <View style={styles.flex}>
        <Text style={styles.greeting}>
          Hello{user.displayName ? `, ${user.displayName}` : ''}
        </Text>
        <Text numberOfLines={1} style={styles.email}>
          {user.email ?? 'signed in'}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={onSignOut}
        style={({ pressed }) => [styles.signOutButton, pressed && styles.pressed]}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  greeting: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  email: {
    marginTop: 2,
    fontSize: fontSize.xs,
    color: colors.textFaint,
  },
  signOutButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceMuted,
  },
  signOutText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  pressed: { opacity: 0.75 },
});
