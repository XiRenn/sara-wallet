import { describe, expect, it } from 'vitest';

import type { WalletRow } from '../database';
import { SUPPORTED_CURRENCIES, isTransactionType, normaliseWallet, toNumber } from '../wallet';

function walletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    user_id: '20000000-0000-4000-8000-000000000001',
    name: 'Cash',
    currency: 'MMK',
    balance: 0,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('toNumber', () => {
  it('passes a finite number through', () => {
    expect(toNumber(1500)).toBe(1500);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-250.5)).toBe(-250.5);
  });

  it('parses the string form PostgREST sometimes returns for numeric', () => {
    expect(toNumber('1500')).toBe(1500);
    expect(toNumber('1500.25')).toBe(1500.25);
    expect(toNumber('-250.50')).toBe(-250.5);
  });

  it('returns the fallback for NaN and Infinity', () => {
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toNumber('not a number')).toBe(0);
  });

  it('returns the fallback for null, undefined and objects', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber({})).toBe(0);
    expect(toNumber([])).toBe(0);
  });

  it('honours a custom fallback', () => {
    expect(toNumber(null, -1)).toBe(-1);
    expect(toNumber('garbage', 42)).toBe(42);
  });

  it('coerces an empty string to zero, which is what Number("") gives', () => {
    // Documented so nobody "fixes" it into returning the fallback and quietly
    // changes how a blank numeric column reads.
    expect(toNumber('')).toBe(0);
  });
});

describe('normaliseWallet', () => {
  it('coerces a string balance to a number', () => {
    expect(normaliseWallet(walletRow({ balance: '50000.00' as unknown as number })).balance).toBe(
      50_000,
    );
  });

  it('leaves a numeric balance alone', () => {
    expect(normaliseWallet(walletRow({ balance: 1234.56 })).balance).toBe(1234.56);
  });

  it('preserves every other column', () => {
    const row = walletRow({ name: 'Savings', currency: 'THB', balance: 7 });
    expect(normaliseWallet(row)).toEqual({ ...row, balance: 7 });
  });

  it('never produces a non-finite balance', () => {
    const result = normaliseWallet(walletRow({ balance: Number.NaN }));
    expect(Number.isFinite(result.balance)).toBe(true);
    expect(result.balance).toBe(0);
  });
});

describe('isTransactionType', () => {
  it('accepts the two enum members', () => {
    expect(isTransactionType('INCOME')).toBe(true);
    expect(isTransactionType('EXPENSE')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isTransactionType('TRANSFER')).toBe(false);
    expect(isTransactionType('income')).toBe(false);
    expect(isTransactionType(null)).toBe(false);
    expect(isTransactionType(undefined)).toBe(false);
    expect(isTransactionType(0)).toBe(false);
  });
});

describe('SUPPORTED_CURRENCIES', () => {
  it('contains only 3-letter uppercase codes', () => {
    for (const code of SUPPORTED_CURRENCIES) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(SUPPORTED_CURRENCIES.length);
  });

  it('includes MMK, the default for this app', () => {
    expect(SUPPORTED_CURRENCIES).toContain('MMK');
  });
});
