import { describe, expect, it } from 'vitest';

import {
  formatAmount,
  formatCurrency,
  formatSignedCurrency,
  parseAmount,
  toDecimalString,
} from '../currency';

/**
 * `Intl` separates a currency code from the number with a non-breaking space
 * (U+00A0) and some engines use a narrow no-break space (U+202F). Asserting on
 * the raw string would make these tests fail on an ICU update, so whitespace is
 * normalised first — the behaviour under test is the number formatting, not the
 * flavour of space the platform picked.
 */
function norm(value: string): string {
  return value.replace(/[\u00a0\u202f]/g, ' ');
}

/**
 * A locale string Node's ICU rejects outright. `formatCurrency` catches the
 * `RangeError` and falls back to its hand-rolled formatter, which is what
 * actually runs on a Hermes build with no ICU data. Passing this is the only
 * way to exercise that path deterministically.
 */
const NO_ICU = 'en_US';

describe('formatCurrency — Intl path', () => {
  it('defaults to MMK', () => {
    expect(norm(formatCurrency(1500))).toBe('MMK 1,500');
  });

  it('renders a currency code when the locale has no symbol for it', () => {
    expect(norm(formatCurrency(1500, 'MMK'))).toBe('MMK 1,500');
  });

  it('renders a symbol when the locale has one', () => {
    expect(norm(formatCurrency(240.5, 'USD'))).toBe('$240.5');
  });

  it('groups thousands', () => {
    expect(norm(formatCurrency(1_234_567, 'MMK'))).toBe('MMK 1,234,567');
  });

  it('drops trailing zeros by default', () => {
    // 1,500.00 -> 1,500
    expect(norm(formatCurrency(1500, 'USD'))).toBe('$1,500');
  });

  it('keeps exactly two decimals with alwaysShowDecimals', () => {
    expect(norm(formatCurrency(240.5, 'USD', { alwaysShowDecimals: true }))).toBe('$240.50');
    expect(norm(formatCurrency(1500, 'USD', { alwaysShowDecimals: true }))).toBe('$1,500.00');
  });

  it('honours zero-decimal currencies', () => {
    expect(norm(formatCurrency(5000, 'JPY', { alwaysShowDecimals: true }))).toBe('¥5,000');
  });

  it('prefixes negatives with a minus by default', () => {
    expect(norm(formatCurrency(-240.5, 'USD'))).toBe('-$240.5');
  });

  it('wraps negatives in parentheses when asked', () => {
    expect(norm(formatCurrency(-240.5, 'USD', { negativeStyle: 'parentheses' }))).toBe('($240.5)');
  });

  it('never emits a bare minus in parentheses mode', () => {
    expect(norm(formatCurrency(-240.5, 'USD', { negativeStyle: 'parentheses' }))).not.toContain('-');
  });

  it('shows a plus sign for positives when asked', () => {
    expect(norm(formatCurrency(240.5, 'USD', { showPlusForPositive: true }))).toBe('+$240.5');
  });

  it('does not add a plus to zero', () => {
    expect(norm(formatCurrency(0, 'USD', { showPlusForPositive: true }))).toBe('$0');
  });

  it('hides the symbol on request', () => {
    expect(norm(formatCurrency(1500, 'MMK', { hideSymbol: true }))).toBe('1,500');
  });

  it('uses compact notation', () => {
    expect(norm(formatCurrency(1_250_000, 'MMK', { compact: true }))).toBe('MMK 1.3M');
  });

  it('formats zero without a sign', () => {
    expect(norm(formatCurrency(0, 'MMK'))).toBe('MMK 0');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('treats %s as zero rather than emitting "NaN"', (_label, amount) => {
    const out = norm(formatCurrency(amount, 'MMK'));
    expect(out).toBe('MMK 0');
    expect(out).not.toMatch(/NaN|Infinity/);
  });
});

describe('formatCurrency — manual fallback (no ICU)', () => {
  it('falls back instead of throwing on a locale ICU rejects', () => {
    expect(() => formatCurrency(1500, 'MMK', { locale: NO_ICU })).not.toThrow();
  });

  it('produces the same output as the Intl path for a plain integer', () => {
    expect(norm(formatCurrency(1500, 'MMK', { locale: NO_ICU }))).toBe('MMK 1,500');
  });

  it('groups large numbers', () => {
    expect(norm(formatCurrency(1_234_567, 'MMK', { locale: NO_ICU }))).toBe('MMK 1,234,567');
  });

  it('keeps the fractional part', () => {
    expect(norm(formatCurrency(1234.5, 'MMK', { locale: NO_ICU }))).toBe('MMK 1,234.5');
  });

  it('still applies the sign', () => {
    expect(norm(formatCurrency(-240.5, 'USD', { locale: NO_ICU }))).toBe('-USD 240.5');
  });

  it('still applies parentheses', () => {
    expect(norm(formatCurrency(-240.5, 'USD', { locale: NO_ICU, negativeStyle: 'parentheses' }))).toBe(
      '(USD 240.5)',
    );
  });

  it('still hides the symbol', () => {
    expect(norm(formatCurrency(1500, 'MMK', { locale: NO_ICU, hideSymbol: true }))).toBe('1,500');
  });

  it('respects zero-decimal currencies', () => {
    expect(norm(formatCurrency(5000, 'JPY', { locale: NO_ICU }))).toBe('JPY 5,000');
  });

  it('renders zero as "0", not an empty string', () => {
    expect(norm(formatCurrency(0, 'MMK', { locale: NO_ICU }))).toBe('MMK 0');
  });

  it('survives a non-finite amount', () => {
    expect(norm(formatCurrency(Number.NaN, 'MMK', { locale: NO_ICU }))).toBe('MMK 0');
  });
});

describe('formatSignedCurrency', () => {
  it('prefixes INCOME with a plus', () => {
    expect(norm(formatSignedCurrency(1500, 'INCOME', 'MMK'))).toBe('+MMK 1,500');
  });

  it('prefixes EXPENSE with a minus', () => {
    expect(norm(formatSignedCurrency(1500, 'EXPENSE', 'MMK'))).toBe('-MMK 1,500');
  });

  it('uses the magnitude, so a negative input does not double the sign', () => {
    expect(norm(formatSignedCurrency(-1500, 'INCOME', 'MMK'))).toBe('+MMK 1,500');
    expect(norm(formatSignedCurrency(-1500, 'EXPENSE', 'MMK'))).toBe('-MMK 1,500');
  });

  it('always shows the symbol even if the caller asked to hide it', () => {
    expect(norm(formatSignedCurrency(1500, 'INCOME', 'MMK', { hideSymbol: true }))).toBe('+MMK 1,500');
  });
});

describe('formatAmount', () => {
  it('groups digits and drops the symbol', () => {
    expect(norm(formatAmount(1500))).toBe('1,500');
  });

  it('rounds to the requested number of decimals', () => {
    expect(norm(formatAmount(1500.567, 2))).toBe('1,500.57');
  });

  it('defaults to zero decimals', () => {
    expect(norm(formatAmount(1500.9))).toBe('1,501');
  });

  it('treats a non-finite amount as zero', () => {
    expect(norm(formatAmount(Number.NaN))).toBe('0');
  });
});

describe('parseAmount', () => {
  it('parses a plain integer', () => {
    expect(parseAmount('1500')).toBe(1500);
  });

  it('strips grouping commas', () => {
    expect(parseAmount('1,500')).toBe(1500);
  });

  it('parses decimals', () => {
    expect(parseAmount('1500.50')).toBe(1500.5);
  });

  it('expands a "k" suffix', () => {
    expect(parseAmount('12.5k')).toBe(12_500);
  });

  it('expands an "m" suffix', () => {
    expect(parseAmount('2m')).toBe(2_000_000);
  });

  it('is case insensitive about the suffix', () => {
    expect(parseAmount('12.5K')).toBe(12_500);
  });

  it('ignores surrounding currency noise', () => {
    expect(parseAmount('MMK 1,500')).toBe(1500);
    expect(parseAmount('  $ 1,500  ')).toBe(1500);
  });

  it('treats a negative input as a magnitude', () => {
    // The sign is carried by the transaction type, never by the amount.
    expect(parseAmount('-1500')).toBe(1500);
  });

  it('rounds to two decimals', () => {
    expect(parseAmount('10.005')).toBe(10.01);
  });

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['letters only', 'abc'],
    ['zero', '0'],
    ['a bare suffix', 'k'],
  ])('returns null for %s', (_label, input) => {
    expect(parseAmount(input)).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(parseAmount(undefined as unknown as string)).toBeNull();
    expect(parseAmount(null as unknown as string)).toBeNull();
    expect(parseAmount(1500 as unknown as string)).toBeNull();
  });
});

describe('toDecimalString', () => {
  it('pads to two decimals for MMK', () => {
    expect(toDecimalString(1500)).toBe('1500.00');
  });

  it('pads to zero decimals for JPY', () => {
    expect(toDecimalString(1500, 'JPY')).toBe('1500');
  });

  it('rounds rather than truncates', () => {
    expect(toDecimalString(1500.567)).toBe('1500.57');
  });

  it('never emits a non-finite value', () => {
    expect(toDecimalString(Number.NaN)).toBe('0.00');
  });

  it('produces something PostgreSQL numeric(18,2) accepts', () => {
    expect(toDecimalString(1234567.891)).toMatch(/^\d+\.\d{2}$/);
  });
});
