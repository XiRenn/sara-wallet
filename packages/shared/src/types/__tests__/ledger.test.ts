import { describe, expect, it } from 'vitest';

import { createLedgerControls, hasLedgerFilters, type LedgerControls } from '../ledger';

const NOW = new Date(2026, 9, 14, 15, 30);

function controls(patch: Partial<LedgerControls> = {}): LedgerControls {
  return { ...createLedgerControls(NOW), ...patch };
}

describe('createLedgerControls', () => {
  it('starts on the current month, unfiltered', () => {
    const value = createLedgerControls(NOW);
    expect(value.month.getFullYear()).toBe(2026);
    expect(value.month.getMonth()).toBe(9);
    expect(value.month.getDate()).toBe(1);
    expect(value.scope).toBe('month');
    expect(value.search).toBe('');
    expect(value.type).toBeNull();
    expect(value.category).toBeNull();
  });

  it('normalises a mid-month "now" back to the first', () => {
    const value = createLedgerControls(new Date(2026, 1, 28, 23, 59));
    expect(value.month.getDate()).toBe(1);
    expect(value.month.getHours()).toBe(0);
  });
});

describe('hasLedgerFilters', () => {
  it('is false for the default view', () => {
    expect(hasLedgerFilters(createLedgerControls(NOW))).toBe(false);
  });

  it('is false for whitespace that only looks like a search', () => {
    expect(hasLedgerFilters(controls({ search: '   ' }))).toBe(false);
  });

  it('notices each filter on its own', () => {
    expect(hasLedgerFilters(controls({ search: 'rent' }))).toBe(true);
    expect(hasLedgerFilters(controls({ type: 'EXPENSE' }))).toBe(true);
    expect(hasLedgerFilters(controls({ category: 'Food' }))).toBe(true);
  });

  it('ignores where you are looking, only what you filtered for', () => {
    // Month navigation and the all-time scope are not filters — clearing them
    // would move the user somewhere they did not ask to go.
    expect(hasLedgerFilters(controls({ scope: 'all' }))).toBe(false);
    expect(hasLedgerFilters(controls({ month: new Date(2025, 0, 1) }))).toBe(false);
  });
});
