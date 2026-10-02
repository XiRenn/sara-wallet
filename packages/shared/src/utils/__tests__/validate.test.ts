import { describe, expect, it } from 'vitest';

import { AppError } from '../errors';
import {
  assertCurrencyCode,
  assertEmail,
  assertIsoDate,
  assertNonEmptyString,
  assertNonNegativeAmount,
  assertOptionalString,
  assertPassword,
  assertPositiveAmount,
  assertUuid,
  isUuid,
} from '../validate';

/** Every validator must fail with a typed `AppError`, never a bare Error. */
function catchAppError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw new Error(`Expected an AppError, got: ${String(error)}`);
  }
  throw new Error('Expected the validator to throw, but it returned normally.');
}

const VALID_UUID_V4 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const VALID_UUID_V1 = '123e4567-e89b-12d3-a456-426614174000';

describe('assertUuid', () => {
  it('accepts a v4 uuid', () => {
    expect(assertUuid(VALID_UUID_V4, 'walletId')).toBe(VALID_UUID_V4);
  });

  it('accepts a v1 uuid', () => {
    expect(assertUuid(VALID_UUID_V1, 'walletId')).toBe(VALID_UUID_V1);
  });

  it('is case insensitive but does not rewrite the value', () => {
    const upper = VALID_UUID_V4.toUpperCase();
    expect(assertUuid(upper, 'walletId')).toBe(upper);
  });

  it('names the offending field in the message', () => {
    expect(catchAppError(() => assertUuid('nope', 'fromWalletId')).message).toContain('fromWalletId');
  });

  it('reports validation_error', () => {
    expect(catchAppError(() => assertUuid('nope', 'walletId')).code).toBe('validation_error');
  });

  it.each([
    ['a non-uuid string', 'not-a-uuid'],
    ['an empty string', ''],
    ['a uuid with the wrong length', 'a0eebc99-9c0b-4ef8-bb6d'],
    ['the nil uuid (version 0, variant 0)', '00000000-0000-0000-0000-000000000000'],
    ['a uuid with a bad variant', 'a0eebc99-9c0b-4ef8-7b6d-6bb9bd380a11'],
    ['a uuid with a bad version', 'a0eebc99-9c0b-9ef8-bb6d-6bb9bd380a11'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => assertUuid(value, 'walletId')).toThrow(AppError);
  });
});

describe('isUuid', () => {
  it('accepts a valid uuid', () => {
    expect(isUuid(VALID_UUID_V4)).toBe(true);
  });

  it('rejects everything else without throwing', () => {
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('narrows the type', () => {
    const value: unknown = VALID_UUID_V4;
    if (isUuid(value)) {
      // Type-level assertion: this only compiles if `value` is narrowed to string.
      expect(value.toUpperCase()).toBe(VALID_UUID_V4.toUpperCase());
    }
  });
});

describe('assertNonEmptyString', () => {
  it('trims and returns the value', () => {
    expect(assertNonEmptyString('  Cash  ', 'name', 80)).toBe('Cash');
  });

  it('accepts a value exactly at the limit', () => {
    const value = 'x'.repeat(80);
    expect(assertNonEmptyString(value, 'name', 80)).toBe(value);
  });

  it('rejects a value one character over the limit', () => {
    expect(() => assertNonEmptyString('x'.repeat(81), 'name', 80)).toThrow(AppError);
  });

  it('rejects whitespace-only input', () => {
    expect(catchAppError(() => assertNonEmptyString('   ', 'name', 80)).code).toBe('validation_error');
  });

  it('rejects a non-string', () => {
    expect(() => assertNonEmptyString(42, 'name', 80)).toThrow(AppError);
    expect(() => assertNonEmptyString(null, 'name', 80)).toThrow(AppError);
  });
});

describe('assertOptionalString', () => {
  it('returns undefined for undefined, null and blank input', () => {
    expect(assertOptionalString(undefined, 'note', 500)).toBeUndefined();
    expect(assertOptionalString(null, 'note', 500)).toBeUndefined();
    expect(assertOptionalString('   ', 'note', 500)).toBeUndefined();
  });

  it('trims a real value', () => {
    expect(assertOptionalString('  lunch  ', 'note', 500)).toBe('lunch');
  });

  it('rejects an over-long value', () => {
    expect(() => assertOptionalString('x'.repeat(501), 'note', 500)).toThrow(AppError);
  });

  it('rejects a non-string, non-null value', () => {
    expect(() => assertOptionalString(42, 'note', 500)).toThrow(AppError);
  });
});

describe('assertCurrencyCode', () => {
  it('uppercases a lowercase code', () => {
    expect(assertCurrencyCode('mmk')).toBe('MMK');
  });

  it('trims before validating', () => {
    expect(assertCurrencyCode('  usd  ')).toBe('USD');
  });

  it.each(['MM', 'MMKK', 'M1K', '123', 'US'])('rejects %s', (value) => {
    expect(() => assertCurrencyCode(value)).toThrow(AppError);
  });

  it('rejects a non-string', () => {
    expect(() => assertCurrencyCode(42)).toThrow(AppError);
    expect(() => assertCurrencyCode(null)).toThrow(AppError);
  });

  it('names the field it was given', () => {
    expect(catchAppError(() => assertCurrencyCode('X', 'fromCurrency')).message).toContain(
      'fromCurrency',
    );
  });

  it('accepts every currency the UI offers', () => {
    for (const code of ['MMK', 'THB', 'USD', 'SGD', 'MYR', 'EUR', 'GBP', 'CNY', 'JPY', 'INR']) {
      expect(assertCurrencyCode(code)).toBe(code);
    }
  });
});

describe('assertPositiveAmount', () => {
  it('accepts a number', () => {
    expect(assertPositiveAmount(1500)).toBe(1500);
  });

  it('coerces a numeric string', () => {
    expect(assertPositiveAmount('1500')).toBe(1500);
  });

  it('rounds to two decimals so the value fits numeric(18,2)', () => {
    expect(assertPositiveAmount(12.345)).toBe(12.35);
  });

  it('rejects zero and negatives', () => {
    expect(() => assertPositiveAmount(0)).toThrow(AppError);
    expect(() => assertPositiveAmount(-1)).toThrow(AppError);
    expect(() => assertPositiveAmount('-1500')).toThrow(AppError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => assertPositiveAmount(Number.NaN)).toThrow(AppError);
    expect(() => assertPositiveAmount(Number.POSITIVE_INFINITY)).toThrow(AppError);
    expect(() => assertPositiveAmount('abc')).toThrow(AppError);
  });

  it('rejects an amount above the sanity ceiling', () => {
    const error = catchAppError(() => assertPositiveAmount(1_000_000_000_001));
    expect(error.message).toContain('unrealistically large');
  });

  it('accepts the ceiling itself', () => {
    expect(assertPositiveAmount(1_000_000_000_000)).toBe(1_000_000_000_000);
  });
});

describe('assertNonNegativeAmount', () => {
  it('accepts zero — used for opening balances', () => {
    expect(assertNonNegativeAmount(0)).toBe(0);
  });

  it('accepts a positive value', () => {
    expect(assertNonNegativeAmount('50000')).toBe(50_000);
  });

  it('rejects a negative value', () => {
    expect(catchAppError(() => assertNonNegativeAmount(-0.01)).code).toBe('validation_error');
  });

  it('rejects a non-number', () => {
    expect(() => assertNonNegativeAmount(Number.NaN)).toThrow(AppError);
  });
});

describe('assertEmail', () => {
  it('trims and lowercases', () => {
    expect(assertEmail('  Xirenn@Example.COM  ')).toBe('xirenn@example.com');
  });

  it.each(['a@b.co', 'first.last+tag@sub.domain.com', "o'brien@example.com"])('accepts %s', (value) => {
    expect(assertEmail(value)).toBe(value.toLowerCase());
  });

  it.each([
    ['no at sign', 'nope'],
    ['no domain', 'a@'],
    ['no local part', '@b.com'],
    ['a one-character tld', 'a@b.c'],
    ['an embedded space', 'a b@c.com'],
    ['a trailing dot', 'a@b.'],
  ])('rejects %s', (_label, value) => {
    expect(() => assertEmail(value)).toThrow(AppError);
  });

  it('rejects a non-string', () => {
    expect(() => assertEmail(null)).toThrow(AppError);
    expect(() => assertEmail(42)).toThrow(AppError);
  });
});

describe('assertPassword', () => {
  it('accepts a password at the minimum length', () => {
    expect(assertPassword('12345678')).toBe('12345678');
  });

  it('returns the password untouched — no trimming', () => {
    // Trimming a password would silently change it and break sign-in.
    expect(assertPassword('  spaces  ')).toBe('  spaces  ');
  });

  it('rejects a short password with weak_password, not validation_error', () => {
    // The UI keys off this code to show password-specific guidance.
    expect(catchAppError(() => assertPassword('1234567')).code).toBe('weak_password');
  });

  it('honours a custom minimum', () => {
    expect(assertPassword('123456', 6)).toBe('123456');
    expect(catchAppError(() => assertPassword('12345', 6)).code).toBe('weak_password');
  });

  it('rejects a non-string with validation_error', () => {
    expect(catchAppError(() => assertPassword(12345678)).code).toBe('validation_error');
  });

  it('states the required length in the message', () => {
    expect(catchAppError(() => assertPassword('short')).message).toContain('8');
  });
});

describe('assertIsoDate', () => {
  it('defaults to now when the value is absent', () => {
    const before = Date.now();
    const result = assertIsoDate(undefined);
    const parsed = new Date(result).getTime();
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('defaults to now for null', () => {
    expect(assertIsoDate(null)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serialises a Date to a UTC ISO string', () => {
    expect(assertIsoDate(new Date(Date.UTC(2026, 9, 1, 9, 0, 0)))).toBe('2026-10-01T09:00:00.000Z');
  });

  it('parses an ISO string and normalises it', () => {
    expect(assertIsoDate('2026-10-01T09:00:00.000Z')).toBe('2026-10-01T09:00:00.000Z');
  });

  it('normalises a date-only string to a full timestamp', () => {
    // PostgREST wants a timestamptz, not a bare date.
    expect(assertIsoDate('2026-10-01')).toBe(new Date('2026-10-01').toISOString());
  });

  it('rejects an unparseable string', () => {
    expect(catchAppError(() => assertIsoDate('not a date')).code).toBe('validation_error');
  });

  it('names the field it was given', () => {
    expect(catchAppError(() => assertIsoDate('nope', 'transactionDate')).message).toContain(
      'transactionDate',
    );
  });

  it('round-trips through the shared date helpers', () => {
    const iso = assertIsoDate('2026-10-01T00:00:00.000Z');
    expect(new Date(iso).getUTCFullYear()).toBe(2026);
    expect(new Date(iso).getUTCMonth()).toBe(9);
    expect(new Date(iso).getUTCDate()).toBe(1);
  });
});
