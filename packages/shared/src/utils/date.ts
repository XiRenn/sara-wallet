/**
 * Date helpers. Everything is timezone-aware via the device locale and safe
 * on both Hermes (RN) and Chromium (Electron).
 */

import { assertIsoDate } from './validate';

export type DateInput = Date | string | number;

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function toDate(input: DateInput): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date input: ${String(input)}`);
  }
  return date;
}

export function isValidDate(input: unknown): boolean {
  if (input instanceof Date) return !Number.isNaN(input.getTime());
  if (typeof input === 'string' || typeof input === 'number') {
    return !Number.isNaN(new Date(input).getTime());
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Range helpers                                                               */
/* -------------------------------------------------------------------------- */

export function startOfMonth(input: DateInput = new Date()): Date {
  const date = toDate(input);
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

export function endOfMonth(input: DateInput = new Date()): Date {
  const date = toDate(input);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function startOfDay(input: DateInput = new Date()): Date {
  const date = toDate(input);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function addMonths(input: DateInput, amount: number): Date {
  const date = toDate(input);
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

export function isSameDay(a: DateInput, b: DateInput): boolean {
  const left = toDate(a);
  const right = toDate(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function isSameMonth(a: DateInput, b: DateInput): boolean {
  const left = toDate(a);
  const right = toDate(b);
  return (
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth()
  );
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                               */
/* -------------------------------------------------------------------------- */

/** Local-time `YYYY-MM-DD`, safe to send to a PostgreSQL `date` column. */
export function toISODate(input: DateInput = new Date()): string {
  const date = toDate(input);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reduces a caller-supplied date to `YYYY-MM-DD` for a PostgreSQL `date`
 * column.
 *
 * Not the same thing as `toISODate(new Date(value))`, and the difference is a
 * real bug rather than pedantry. `new Date('2026-10-01')` parses as *UTC*
 * midnight, so in any negative-offset timezone the local getters return the
 * previous day — a user in New York picking 1 October would file the row on
 * 30 September. A date-only string is therefore passed through untouched, and
 * anything else keeps the day it falls on *locally*: the day the user picked.
 *
 * Used by the transaction service for range bounds and by the debt service for
 * `issued_on` / `due_on`. A nullish input means "now", matching `assertIsoDate`.
 */
export function toDateBound(value: DateInput | null | undefined, field = 'date'): string {
  if (value === undefined || value === null) return toISODate(new Date());
  if (typeof value === 'string' && DATE_ONLY.test(value)) return value;
  return toISODate(new Date(assertIsoDate(value, field)));
}

/** `'2026-10'` — used as a React key and for month pickers. */
export function toMonthKey(input: DateInput = new Date()): string {  const date = toDate(input);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`;
}

/** First day of the month as `'YYYY-MM-01'` — the RPC's `p_month` argument. */
export function toMonthStart(input: DateInput = new Date()): string {
  return toISODate(startOfMonth(input));
}

/** Full ISO timestamp for `timestamptz` columns. */
export function toISOString(input: DateInput = new Date()): string {
  return toDate(input).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Display                                                                     */
/* -------------------------------------------------------------------------- */

export type DateStyle = 'short' | 'medium' | 'long' | 'month' | 'time' | 'datetime';

/** `'2026-10-01T09:00:00Z'` -> `'1 Oct 2026'` */
export function formatDate(input: DateInput, style: DateStyle = 'medium'): string {
  const date = toDate(input);
  const day = date.getDate();
  const monthShort = MONTHS_SHORT[date.getMonth()];
  const year = date.getFullYear();

  switch (style) {
    case 'short':
      return `${`${date.getMonth() + 1}`.padStart(2, '0')}/${`${day}`.padStart(2, '0')}/${year}`;
    case 'medium':
      return `${day} ${monthShort} ${year}`;
    case 'long':
      return `${DAYS_SHORT[date.getDay()]}, ${day} ${monthShort} ${year}`;
    case 'month':
      return `${monthShort} ${year}`;
    case 'time': {
      const hh = `${date.getHours()}`.padStart(2, '0');
      const mm = `${date.getMinutes()}`.padStart(2, '0');
      return `${hh}:${mm}`;
    }
    case 'datetime':
      return `${day} ${monthShort} ${year}, ${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`;
    default:
      return `${day} ${monthShort} ${year}`;
  }
}

/** `'Today'`, `'Yesterday'`, `'3 days ago'`, or a formatted date past a week. */
export function formatRelative(input: DateInput, now: DateInput = new Date()): string {
  const date = startOfDay(input);
  const today = startOfDay(now);
  const diffDays = Math.round(
    (today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays === -1) return 'Tomorrow';
  if (diffDays > 1 && diffDays <= 6) return `${diffDays} days ago`;
  if (diffDays < -1 && diffDays >= -6) return `In ${Math.abs(diffDays)} days`;
  return formatDate(date, 'medium');
}

/** Groups list items into day buckets, newest day first. */
export function groupByDay<T>(
  items: readonly T[],
  getDate: (item: T) => DateInput,
  now: DateInput = new Date(),
): Array<{ key: string; label: string; items: T[] }> {
  const buckets = new Map<string, T[]>();

  for (const item of items) {
    const key = toISODate(getDate(item));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, bucketItems]) => ({
      key,
      label: formatRelative(`${key}T00:00:00`, now),
      items: bucketItems,
    }));
}

/** Days in the given month — used by date pickers. */
export function daysInMonth(input: DateInput = new Date()): number {
  const date = toDate(input);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}
