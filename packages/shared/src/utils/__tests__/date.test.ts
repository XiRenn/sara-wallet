import { describe, expect, it } from 'vitest';

import {
  addMonths,
  daysInMonth,
  endOfMonth,
  formatDate,
  formatRelative,
  groupByDay,
  isSameDay,
  isSameMonth,
  isValidDate,
  startOfDay,
  startOfMonth,
  toDate,
  toDateBound,
  toISODate,
  toISOString,
  toMonthKey,
  toMonthStart,
} from '../date';

/**
 * Every date below is built with the local-time `Date` constructor
 * (`new Date(2026, 9, 1)`) and read back with local getters. That keeps the
 * suite independent of the machine's timezone — a UTC-based fixture would pass
 * in Mandalay (GMT+6:30) and fail on a CI box in UTC.
 */

/** 1 Oct 2026, a Thursday. */
const OCT_1_2026 = new Date(2026, 9, 1);

describe('toDate', () => {
  it('returns the same instance when handed a Date', () => {
    expect(toDate(OCT_1_2026)).toBe(OCT_1_2026);
  });

  it('parses an ISO string', () => {
    expect(toDate('2026-10-01T00:00:00.000Z').getTime()).toBe(
      new Date('2026-10-01T00:00:00.000Z').getTime(),
    );
  });

  it('accepts an epoch number', () => {
    expect(toDate(0).getTime()).toBe(0);
  });

  it('throws a RangeError on an unparseable string', () => {
    expect(() => toDate('not a date')).toThrow(RangeError);
  });

  it('throws a RangeError on an invalid Date instance', () => {
    expect(() => toDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('isValidDate', () => {
  it('accepts a real Date', () => {
    expect(isValidDate(OCT_1_2026)).toBe(true);
  });

  it('rejects an invalid Date', () => {
    expect(isValidDate(new Date(Number.NaN))).toBe(false);
  });

  it('accepts a parseable string and a number', () => {
    expect(isValidDate('2026-10-01')).toBe(true);
    expect(isValidDate(0)).toBe(true);
  });

  it('rejects null, undefined and objects', () => {
    expect(isValidDate(null)).toBe(false);
    expect(isValidDate(undefined)).toBe(false);
    expect(isValidDate({})).toBe(false);
  });
});

describe('month / day boundaries', () => {
  it('startOfMonth snaps to the first day at midnight', () => {
    const result = startOfMonth(new Date(2026, 9, 15, 13, 45, 30, 123));
    expect(result.getTime()).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).getTime());
  });

  it('startOfMonth is a no-op for a date already on the first', () => {
    expect(startOfMonth(OCT_1_2026).getTime()).toBe(OCT_1_2026.getTime());
  });

  it('endOfMonth snaps to the last day at 23:59:59.999', () => {
    const result = endOfMonth(new Date(2026, 9, 15));
    expect(result.getTime()).toBe(new Date(2026, 9, 31, 23, 59, 59, 999).getTime());
  });

  it('endOfMonth lands on 28 February in a non-leap year', () => {
    expect(endOfMonth(new Date(2026, 1, 10)).getDate()).toBe(28);
  });

  it('endOfMonth lands on 29 February in a leap year', () => {
    expect(endOfMonth(new Date(2024, 1, 10)).getDate()).toBe(29);
  });

  it('endOfMonth handles December without rolling the year', () => {
    const result = endOfMonth(new Date(2026, 11, 5));
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(11);
    expect(result.getDate()).toBe(31);
  });

  it('startOfDay zeroes the clock', () => {
    expect(startOfDay(new Date(2026, 9, 15, 23, 59, 59, 999)).getTime()).toBe(
      new Date(2026, 9, 15, 0, 0, 0, 0).getTime(),
    );
  });

  it('the month window is inclusive of both ends', () => {
    const start = startOfMonth(OCT_1_2026);
    const end = endOfMonth(OCT_1_2026);
    expect(start.getTime()).toBeLessThan(end.getTime());
    expect(isSameMonth(start, end)).toBe(true);
  });
});

describe('addMonths', () => {
  it('moves forward and snaps to the first of the month', () => {
    expect(addMonths(new Date(2026, 9, 15), 1).getTime()).toBe(new Date(2026, 10, 1).getTime());
  });

  it('moves backward', () => {
    expect(addMonths(new Date(2026, 9, 15), -3).getTime()).toBe(new Date(2026, 6, 1).getTime());
  });

  it('rolls over the year boundary forward', () => {
    expect(addMonths(new Date(2026, 11, 5), 1).getTime()).toBe(new Date(2027, 0, 1).getTime());
  });

  it('rolls over the year boundary backward', () => {
    expect(addMonths(new Date(2026, 0, 5), -1).getTime()).toBe(new Date(2025, 11, 1).getTime());
  });

  it('is a no-op for zero', () => {
    expect(addMonths(new Date(2026, 9, 15), 0).getTime()).toBe(new Date(2026, 9, 1).getTime());
  });
});

describe('isSameDay / isSameMonth', () => {
  it('isSameDay ignores the time of day', () => {
    expect(isSameDay(new Date(2026, 9, 15, 0, 0), new Date(2026, 9, 15, 23, 59))).toBe(true);
  });

  it('isSameDay distinguishes adjacent days', () => {
    expect(isSameDay(new Date(2026, 9, 15), new Date(2026, 9, 16))).toBe(false);
  });

  it('isSameMonth ignores the day', () => {
    expect(isSameMonth(new Date(2026, 9, 1), new Date(2026, 9, 31))).toBe(true);
  });

  it('isSameMonth rejects the same day in a different year', () => {
    expect(isSameMonth(new Date(2026, 9, 1), new Date(2025, 9, 1))).toBe(false);
  });
});

describe('serialisation', () => {
  it('toISODate pads single-digit months and days', () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('toISODate does not shift the calendar day across timezones', () => {
    // Local getters, so 1 Jan stays 1 Jan regardless of the machine's offset.
    expect(toISODate(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
    expect(toISODate(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01');
  });

  it('toISODate defaults to today', () => {
    expect(toISODate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('toMonthKey returns YYYY-MM', () => {
    expect(toMonthKey(new Date(2026, 9, 15))).toBe('2026-10');
    expect(toMonthKey(new Date(2026, 0, 5))).toBe('2026-01');
  });

  it('toMonthStart returns the first of the month', () => {
    expect(toMonthStart(new Date(2026, 9, 15))).toBe('2026-10-01');
  });

  it('toISOString round-trips through Date', () => {
    const utc = new Date(Date.UTC(2026, 9, 1, 9, 0, 0));
    expect(toISOString(utc)).toBe('2026-10-01T09:00:00.000Z');
  });

  it('toMonthStart is exactly what the RPC expects as p_month', () => {
    expect(toMonthStart(new Date(2026, 9, 15))).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

describe('formatDate', () => {
  const morning = new Date(2026, 9, 1, 9, 5);

  it('short', () => {
    expect(formatDate(morning, 'short')).toBe('10/01/2026');
  });

  it('medium (the default)', () => {
    expect(formatDate(morning)).toBe('1 Oct 2026');
    expect(formatDate(morning, 'medium')).toBe('1 Oct 2026');
  });

  it('long includes the weekday', () => {
    expect(formatDate(morning, 'long')).toBe('Thu, 1 Oct 2026');
  });

  it('month drops the day', () => {
    expect(formatDate(morning, 'month')).toBe('Oct 2026');
  });

  it('time is zero-padded 24-hour', () => {
    expect(formatDate(morning, 'time')).toBe('09:05');
  });

  it('datetime combines the two', () => {
    expect(formatDate(morning, 'datetime')).toBe('1 Oct 2026, 09:05');
  });

  it('falls back to medium for an unknown style', () => {
    expect(formatDate(morning, 'nonsense' as never)).toBe('1 Oct 2026');
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 9, 15, 12, 0);

  it('today', () => {
    expect(formatRelative(new Date(2026, 9, 15, 1, 0), now)).toBe('Today');
    expect(formatRelative(new Date(2026, 9, 15, 23, 0), now)).toBe('Today');
  });

  it('yesterday and tomorrow', () => {
    expect(formatRelative(new Date(2026, 9, 14, 23, 0), now)).toBe('Yesterday');
    expect(formatRelative(new Date(2026, 9, 16, 0, 30), now)).toBe('Tomorrow');
  });

  it('a few days back', () => {
    expect(formatRelative(new Date(2026, 9, 12), now)).toBe('3 days ago');
  });

  it('a few days ahead', () => {
    expect(formatRelative(new Date(2026, 9, 18), now)).toBe('In 3 days');
  });

  it('uses the last relative bucket at 6 days', () => {
    expect(formatRelative(new Date(2026, 9, 9), now)).toBe('6 days ago');
  });

  it('falls back to a real date past a week', () => {
    expect(formatRelative(new Date(2026, 9, 8), now)).toBe('8 Oct 2026');
  });

  it('falls back to a real date more than a week ahead', () => {
    expect(formatRelative(new Date(2026, 9, 22), now)).toBe('22 Oct 2026');
  });
});

describe('groupByDay', () => {
  const now = new Date(2026, 9, 15, 12, 0);

  const items = [
    { id: 'a', at: new Date(2026, 9, 15, 9, 0) },
    { id: 'b', at: new Date(2026, 9, 14, 12, 0) },
    { id: 'c', at: new Date(2026, 9, 15, 18, 0) },
  ];

  it('buckets by calendar day, newest day first', () => {
    const groups = groupByDay(items, (item) => item.at, now);
    expect(groups.map((group) => group.key)).toEqual(['2026-10-15', '2026-10-14']);
  });

  it('preserves the input order inside a bucket', () => {
    const groups = groupByDay(items, (item) => item.at, now);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('labels the buckets relative to now', () => {
    const groups = groupByDay(items, (item) => item.at, now);
    expect(groups[0]?.label).toBe('Today');
    expect(groups[1]?.label).toBe('Yesterday');
  });

  it('returns an empty array for no items', () => {
    expect(groupByDay([], (item: { at: Date }) => item.at, now)).toEqual([]);
  });
});

describe('daysInMonth', () => {
  it.each([
    ['January', new Date(2026, 0, 15), 31],
    ['February (common year)', new Date(2026, 1, 15), 28],
    ['February (leap year)', new Date(2024, 1, 15), 29],
    ['April', new Date(2026, 3, 15), 30],
    ['December', new Date(2026, 11, 15), 31],
  ])('%s', (_label, date, expected) => {
    expect(daysInMonth(date)).toBe(expected);
  });

  it('accepts an ISO string', () => {
    expect(daysInMonth('2024-02-10')).toBe(29);
  });
});

describe('toDateBound', () => {
  it('passes a date-only string through untouched', () => {
    // This is the whole point of the function. `new Date('2026-10-01')` is UTC
    // midnight, so in any negative-offset timezone the local getters would
    // return 30 September — a user picking 1 October would file it on the 30th.
    expect(toDateBound('2026-10-01')).toBe('2026-10-01');
  });

  it('keeps the local day of a Date, including one near midnight', () => {
    expect(toDateBound(new Date(2026, 9, 1, 23, 59))).toBe('2026-10-01');
    expect(toDateBound(new Date(2026, 9, 1, 0, 0))).toBe('2026-10-01');
  });

  it('keeps the local day of a full ISO instant', () => {
    const instant = new Date(2026, 9, 1, 12, 0).toISOString();
    expect(toDateBound(instant)).toBe('2026-10-01');
  });

  it('treats a nullish value as now, matching assertIsoDate', () => {
    expect(toDateBound(undefined)).toBe(toISODate(new Date()));
    expect(toDateBound(null)).toBe(toISODate(new Date()));
  });

  it('names the offending field when the value is not a date', () => {
    expect(() => toDateBound('not a date', 'dueOn')).toThrow(/dueOn/);
  });
});
