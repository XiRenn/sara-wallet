/**
 * The Ledger / Debts switch.
 *
 * A segmented control rather than a bottom tab bar: there are two destinations,
 * both are the same kind of thing (a full-width list), and the app already has
 * a floating action button pinned to the bottom — a tab bar would fight it for
 * the same corner.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

export interface TabOption<T extends string> {
  value: T;
  label: string;
  /** Shown as a count next to the label when greater than zero. */
  count?: number;
  /**
   * Paints the count red. Used for overdue debts, which is the only thing in
   * the app that is genuinely urgent — it is a "late" red, not an income red.
   */
  countAlarming?: boolean;
}

interface TabStripProps<T extends string> {
  tabs: ReadonlyArray<TabOption<T>>;
  value: T;
  onChange: (value: T) => void;
}

export function TabStrip<T extends string>({ tabs, value, onChange }: TabStripProps<T>) {
  return (
    <View style={styles.strip}>
      {tabs.map((tab) => {
        const active = tab.value === value;
        const showCount = tab.count !== undefined && tab.count > 0;

        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tab.value)}
            style={[styles.tab, active && styles.tabActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{tab.label}</Text>

            {showCount ? (
              <View
                style={[
                  styles.count,
                  tab.countAlarming ? styles.countAlarming : null,
                  active ? styles.countOnActive : null,
                ]}
              >
                <Text
                  style={[
                    styles.countText,
                    tab.countAlarming ? styles.countTextAlarming : null,
                  ]}
                >
                  {tab.count}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: 4,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
  },
  tabActive: {
    backgroundColor: colors.surface,
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  labelActive: {
    color: colors.text,
  },
  count: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countOnActive: {
    backgroundColor: colors.primarySoft,
  },
  countAlarming: {
    backgroundColor: colors.dangerSoft,
  },
  countText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  countTextAlarming: {
    color: colors.danger,
  },
});
