/**
 * Currency formatting helpers.
 *
 * Hermes (React Native) ships a reduced ICU dataset, and Electron's Chromium
 * ships a full one. `Intl.NumberFormat` is therefore tried first and a plain
 * manual formatter is used as a fallback, so MMK renders identically on both
 * platforms even on devices with no ICU data at all.
 */

import { SUPPORTED_CURRENCIES, type CurrencyCode } from '../types/wallet';

// `SUPPORTED_CURRENCIES` and `CurrencyCode` are re-exported from the package
// barrel via `types/wallet` only — re-exporting them here too would create an
// ambiguous star export.

export interface FormatCurrencyOptions {
  /** BCP-47 tag. Defaults to `en-US`, which is universally available. */
  locale?: string;
  /** Drop the currency symbol/code. Defaults to `false`. */
  hideSymbol?: boolean;
  /** Always show exactly two decimals. Defaults to `false` for clean integers. */
  alwaysShowDecimals?: boolean;
  /** Use compact notation (`1.2M`). Useful on small dashboard tiles. */
  compact?: boolean;
  /** How to render negative amounts. Defaults to `'minus'`. */
  negativeStyle?: 'minus' | 'parentheses';
  /** Prefix negatives with a sign even in parentheses mode. */
  showPlusForPositive?: boolean;
}

/** Currencies whose minor unit is not 1/100. */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'IDR', 'CLP']);

function decimalsFor(currency: CurrencyCode): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/** `1234567.5` -> `'1,234,567.5'` */
function groupDigits(value: string): string {
  const [whole = '0', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function formatNumberManually(amount: number, decimals: number): string {
  const absolute = Math.abs(amount);
  const fixed = absolute.toFixed(decimals);
  // Trim `1.00` -> `1` but keep `1.50` -> `1.5` only when decimals were asked for.
  const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
  return groupDigits(trimmed.length > 0 ? trimmed : '0');
}

/**
 * Formats an amount for display.
 *
 * @example
 *   formatCurrency(1500, 'MMK')                 // 'MMK 1,500'
 *   formatCurrency(-240.5, 'USD')               // '-$240.5'
 *   formatCurrency(-240.5, 'USD', { alwaysShowDecimals: true }) // '-$240.50'
 *   formatCurrency(1250000, 'MMK', { compact: true }) // 'MMK 1.3M'
 *
 * Note: `alwaysShowDecimals` defaults to `false`, so a half-unit amount renders
 * with one decimal (`-$240.5`), not two. Ask for `alwaysShowDecimals` when the
 * amount sits in a column that must line up with its neighbours.
 */
export function formatCurrency(
  amount: number,
  currency: CurrencyCode = 'MMK',
  options: FormatCurrencyOptions = {},
): string {
  const {
    locale = 'en-US',
    hideSymbol = false,
    alwaysShowDecimals = false,
    compact = false,
    negativeStyle = 'minus',
    showPlusForPositive = false,
  } = options;

  const safeAmount = Number.isFinite(amount) ? amount : 0;
  const decimals = alwaysShowDecimals ? decimalsFor(currency) : undefined;
  const sign = safeAmount < 0 ? '-' : showPlusForPositive && safeAmount > 0 ? '+' : '';

  let body: string;
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: hideSymbol ? 'decimal' : 'currency',
      currency,
      currencyDisplay: 'symbol',
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: decimals ?? (compact ? 1 : decimalsFor(currency)),
      minimumFractionDigits: decimals ?? 0,
    });
    body = formatter.format(Math.abs(safeAmount));
  } catch {
    // No Intl, unsupported currency, or a broken locale — degrade gracefully.
    const digits = formatNumberManually(safeAmount, decimals ?? decimalsFor(currency));
    body = hideSymbol ? digits : `${currency.toUpperCase()} ${digits}`;
  }

  if (sign === '-' && negativeStyle === 'parentheses') {
    return `(${body})`;
  }
  return `${sign}${body}`;
}

/** Signed variant used by the transaction list. */
export function formatSignedCurrency(
  amount: number,
  type: 'INCOME' | 'EXPENSE',
  currency: CurrencyCode = 'MMK',
  options: FormatCurrencyOptions = {},
): string {
  const sign = type === 'INCOME' ? '+' : '-';
  return `${sign}${formatCurrency(Math.abs(amount), currency, {
    ...options,
    hideSymbol: false,
  })}`;
}

/** Plain grouped number, no symbol. Handy inside text inputs. */
export function formatAmount(amount: number, decimals = 0): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    }).format(safeAmount);
  } catch {
    return formatNumberManually(safeAmount, decimals);
  }
}

/**
 * Parses user input into a positive number.
 * Accepts `'1,500'`, `'1500.50'`, `'MMK 1 500'`, `'12.5k'`.
 * Returns `null` when the input is not a usable amount.
 */
export function parseAmount(input: string): number | null {
  if (typeof input !== 'string') return null;

  let text = input.trim().toLowerCase();
  if (text.length === 0) return null;

  let multiplier = 1;
  if (/(k)$/.test(text)) {
    multiplier = 1_000;
    text = text.replace(/k$/, '');
  } else if (/(m)$/.test(text)) {
    multiplier = 1_000_000;
    text = text.replace(/m$/, '');
  }

  // Strip everything that is not a digit, separator or minus sign.
  text = text.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (text.length === 0) return null;

  const value = Number(text);
  if (!Number.isFinite(value)) return null;

  const result = Math.abs(value) * multiplier;
  return result > 0 ? Math.round(result * 100) / 100 : null;
}

/** `1500` -> `'1,500.00'` for CSV export / clipboard. */
export function toDecimalString(amount: number, currency: CurrencyCode = 'MMK'): string {
  return (Number.isFinite(amount) ? amount : 0).toFixed(decimalsFor(currency));
}
