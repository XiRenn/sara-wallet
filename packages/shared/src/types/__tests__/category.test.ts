/**
 * The category lists are shared, so they get a test that the *union* is sane —
 * a duplicate would render two chips with the same React key.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_CATEGORIES,
  categoriesForType,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  TRANSFER_CATEGORY,
} from '../category';

describe('category vocabulary', () => {
  it('offers distinct suggestions in each direction', () => {
    expect(new Set(INCOME_CATEGORIES).size).toBe(INCOME_CATEGORIES.length);
    expect(new Set(EXPENSE_CATEGORIES).size).toBe(EXPENSE_CATEGORIES.length);
  });

  it('gives both directions an escape hatch', () => {
    expect(INCOME_CATEGORIES).toContain('Other');
    expect(EXPENSE_CATEGORIES).toContain('Other');
  });

  it('deduplicates the union', () => {
    expect(new Set(ALL_CATEGORIES).size).toBe(ALL_CATEGORIES.length);
    // 'Other' appears in both source lists and must appear once here.
    expect(ALL_CATEGORIES.filter((entry) => entry === 'Other')).toHaveLength(1);
  });

  it('covers every suggestion a picker can produce', () => {
    for (const entry of [...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES]) {
      expect(ALL_CATEGORIES).toContain(entry);
    }
  });

  it('includes the category the transfer RPC writes', () => {
    // `transfer_between_wallets` inserts 'Transfer' on both legs. Without it
    // in the union the filter row could not select a transfer.
    expect(ALL_CATEGORIES).toContain(TRANSFER_CATEGORY);
    expect(TRANSFER_CATEGORY).toBe('Transfer');
  });

  it('is sorted, so the chips do not reshuffle between renders', () => {
    const sorted = [...ALL_CATEGORIES].sort((a, b) => a.localeCompare(b));
    expect(ALL_CATEGORIES).toEqual(sorted);
  });

  it('never offers Transfer as a manual choice', () => {
    expect(categoriesForType('INCOME')).not.toContain(TRANSFER_CATEGORY);
    expect(categoriesForType('EXPENSE')).not.toContain(TRANSFER_CATEGORY);
  });

  it('maps a direction to its own list', () => {
    expect(categoriesForType('INCOME')).toBe(INCOME_CATEGORIES);
    expect(categoriesForType('EXPENSE')).toBe(EXPENSE_CATEGORIES);
  });
});
