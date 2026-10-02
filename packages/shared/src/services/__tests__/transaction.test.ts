/**
 * `getTransactionsPage` is the only place the ledger list is fetched from, so
 * it carries three jobs that are easy to get quietly wrong:
 *
 *   - turning user text into a PostgREST `ilike` pattern without letting a
 *     comma or a `%` change the meaning of the filter;
 *   - asking for exactly `limit + 1` rows so `hasMore` costs one row rather
 *     than a second `count=exact` round trip;
 *   - ordering by a *total* key, because offset paging over a non-unique sort
 *     silently repeats and drops rows.
 *
 * There is no database here — the fake below records the builder calls the
 * service makes, which is what these assertions are about.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WALLET_ID = '22222222-2222-4222-8222-222222222222';

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface FakeState {
  rows: Record<string, unknown>[];
  /**
   * What the counterpart lookup returns. Separate from `rows` because the two
   * queries are different shapes — the page query returns whole transactions,
   * the lookup three columns of every leg in the group.
   */
  transferLegs: Record<string, unknown>[];
  error: { code?: string; message?: string } | null;
  calls: RecordedCall[];
  userId: string | null;
}

const COUNTERPART_COLUMNS = 'transfer_group_id, wallet_id, type';

const harness = vi.hoisted(() => {
  const state: FakeState = {
    rows: [],
    transferLegs: [],
    error: null,
    calls: [],
    userId: '11111111-1111-4111-8111-111111111111',
  };

  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      state.calls.push({ method, args });
      return builder;
    };

  // The chainable surface `getTransactionsPage` actually uses.
  for (const method of ['select', 'eq', 'gte', 'lte', 'or', 'in', 'order', 'range']) {
    builder[method] = record(method);
  }

  // PostgREST builders are thenable — `await query` is what triggers the fetch.
  // Which rows come back depends on which projection was asked for, so the
  // counterpart lookup can be answered separately from the page itself.
  builder.then = (onFulfilled: (value: unknown) => unknown) => {
    const projected = state.calls
      .filter((call) => call.method === 'select')
      .at(-1)?.args[0];
    const rows = projected === 'transfer_group_id, wallet_id, type'
      ? state.transferLegs
      : state.rows;
    return Promise.resolve({ data: state.error ? null : rows, error: state.error }).then(
      onFulfilled,
    );
  };

  return {
    state,
    client: {
      from: (table: string) => {
        state.calls.push({ method: 'from', args: [table] });
        return builder;
      },
    },
  };
});

vi.mock('../../config/supabase', () => ({
  getSupabase: () => harness.client,
}));

vi.mock('../auth', () => ({
  requireUserId: async () => {
    if (!harness.state.userId) throw new Error('not signed in');
    return harness.state.userId;
  },
}));

import {
  buildTransactionQuery,
  getTransactionsPage,
  MAX_PAGE_SIZE,
  resolveTransferEnds,
  searchPattern,
} from '../transaction';

/** Every recorded call of one method, as argument tuples. */
function callsOf(method: string): unknown[][] {
  return harness.state.calls
    .filter((call) => call.method === method)
    .map((call) => call.args);
}

function row(id: string, amount = 10) {
  return { id, amount, category: 'Food', note: null, transfer_group_id: null };
}

/** A transfer leg as the counterpart lookup returns it. */
function leg(group: string, walletId: string, type: 'EXPENSE' | 'INCOME') {
  return { transfer_group_id: group, wallet_id: walletId, type };
}

const GROUP = '33333333-3333-4333-8333-333333333333';
const CASH_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  harness.state.rows = [];
  harness.state.transferLegs = [];
  harness.state.error = null;
  harness.state.calls = [];
  harness.state.userId = USER_ID;
});

/* -------------------------------------------------------------------------- */
/* searchPattern                                                               */
/* -------------------------------------------------------------------------- */

describe('searchPattern', () => {
  it('wraps a plain term in a contains pattern', () => {
    expect(searchPattern('coffee')).toBe('"%coffee%"');
  });

  it('trims surrounding whitespace', () => {
    expect(searchPattern('   coffee   ')).toBe('"%coffee%"');
  });

  it('returns null when there is nothing to search for', () => {
    expect(searchPattern('')).toBeNull();
    expect(searchPattern('     ')).toBeNull();
    expect(searchPattern('"')).toBeNull();
  });

  it('escapes the LIKE wildcards so they match literally', () => {
    // The outer `%` are the wildcards; the inner `\%` is a literal percent.
    expect(searchPattern('50%')).toBe('"%50\\%%"');
    expect(searchPattern('a_b')).toBe('"%a\\_b%"');
    expect(searchPattern('back\\slash')).toBe('"%back\\\\slash%"');
  });

  it('quotes the value so the logic-tree grammar treats separators as literal', () => {
    // Unquoted, the comma would split `or=(...)` into two branches and the
    // dot would be read as column.operator.
    expect(searchPattern('lunch, then coffee')).toBe('"%lunch, then coffee%"');
    expect(searchPattern('a.b')).toBe('"%a.b%"');
    expect(searchPattern('(note)')).toBe('"%(note)%"');
  });

  it('drops a literal double quote rather than trying to escape it', () => {
    expect(searchPattern('say "hi"')).toBe('"%say hi%"');
  });
});

/* -------------------------------------------------------------------------- */
/* buildTransactionQuery                                                       */
/* -------------------------------------------------------------------------- */

describe('buildTransactionQuery', () => {
  it('applies the documented defaults', () => {
    expect(buildTransactionQuery()).toEqual({
      walletId: null,
      limit: 50,
      offset: 0,
      ascending: false,
      searchPattern: null,
      type: null,
      category: null,
      from: null,
      to: null,
      debtId: null,
    });
  });

  it('clamps the page size into a sane range', () => {
    expect(buildTransactionQuery({ limit: 10 }).limit).toBe(10);
    expect(buildTransactionQuery({ limit: 5000 }).limit).toBe(MAX_PAGE_SIZE);
    // A real number is clamped to the nearest legal value...
    expect(buildTransactionQuery({ limit: 0 }).limit).toBe(1);
    expect(buildTransactionQuery({ limit: -3 }).limit).toBe(1);
    expect(buildTransactionQuery({ limit: 12.7 }).limit).toBe(12);
    // ...but a non-number is not a value at all, so the default applies.
    expect(buildTransactionQuery({ limit: Number.NaN }).limit).toBe(50);
  });

  it('never lets the offset go negative', () => {
    expect(buildTransactionQuery({ offset: -10 }).offset).toBe(0);
    expect(buildTransactionQuery({ offset: 250 }).offset).toBe(250);
    expect(buildTransactionQuery({ offset: Number.NaN }).offset).toBe(0);
  });

  it('rejects a wallet id that is not a uuid', () => {
    expect(() => buildTransactionQuery({ walletId: 'nope' })).toThrowError(
      /walletId/,
    );
  });

  it('rejects an empty category instead of filtering on nothing', () => {
    expect(() => buildTransactionQuery({ category: '   ' })).toThrowError(/category/);
  });

  it('passes a date-only bound straight through', () => {
    const query = buildTransactionQuery({ from: '2026-10-01', to: '2026-10-31' });
    expect(query.from).toBe('2026-10-01');
    expect(query.to).toBe('2026-10-31');
  });

  it('reduces a Date bound to its local calendar day', () => {
    // Local, not UTC: a midnight in Yangon (UTC+6:30) is the previous day in
    // UTC, and `date` columns have no zone to fall back on.
    const query = buildTransactionQuery({ from: new Date(2026, 9, 1) });
    expect(query.from).toBe('2026-10-01');
  });

  it('rejects a bound that is not a date at all', () => {
    expect(() => buildTransactionQuery({ from: 'not-a-date' })).toThrowError(/from/);
  });

  it('turns a search term into a pattern and keeps it null when empty', () => {
    expect(buildTransactionQuery({ search: ' rent ' }).searchPattern).toBe('"%rent%"');
    expect(buildTransactionQuery({ search: '   ' }).searchPattern).toBeNull();
    expect(buildTransactionQuery({ search: undefined }).searchPattern).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* resolveTransferEnds                                                         */
/* -------------------------------------------------------------------------- */

describe('resolveTransferEnds', () => {
  it('reads the source off the EXPENSE leg and the destination off the INCOME leg', () => {
    // The convention `transfer_between_wallets` writes. Get it backwards and
    // every transfer in the ledger points the wrong way.
    const ends = resolveTransferEnds([
      leg(GROUP, WALLET_ID, 'EXPENSE'),
      leg(GROUP, CASH_ID, 'INCOME'),
    ]);
    expect(ends.get(GROUP)).toEqual({ fromWalletId: WALLET_ID, toWalletId: CASH_ID });
  });

  it('does not depend on which leg the database returns first', () => {
    const ends = resolveTransferEnds([
      leg(GROUP, CASH_ID, 'INCOME'),
      leg(GROUP, WALLET_ID, 'EXPENSE'),
    ]);
    expect(ends.get(GROUP)).toEqual({ fromWalletId: WALLET_ID, toWalletId: CASH_ID });
  });

  it('keeps each transfer separate', () => {
    const other = '55555555-5555-4555-8555-555555555555';
    const ends = resolveTransferEnds([
      leg(GROUP, WALLET_ID, 'EXPENSE'),
      leg(GROUP, CASH_ID, 'INCOME'),
      leg(other, CASH_ID, 'EXPENSE'),
      leg(other, WALLET_ID, 'INCOME'),
    ]);
    expect(ends.get(GROUP)).toEqual({ fromWalletId: WALLET_ID, toWalletId: CASH_ID });
    expect(ends.get(other)).toEqual({ fromWalletId: CASH_ID, toWalletId: WALLET_ID });
  });

  it('ignores ordinary rows, which carry no group', () => {
    const ends = resolveTransferEnds([{ transfer_group_id: null, wallet_id: WALLET_ID, type: 'EXPENSE' }]);
    expect(ends.size).toBe(0);
  });

  it('drops a half-written transfer instead of rendering a one-ended pair', () => {
    // Should be impossible — the RPC writes both legs in one transaction — but
    // a lone leg must fall back to the plain single-wallet cell.
    const ends = resolveTransferEnds([leg(GROUP, WALLET_ID, 'EXPENSE')]);
    expect(ends.has(GROUP)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* getTransactionsPage                                                         */
/* -------------------------------------------------------------------------- */

describe('getTransactionsPage', () => {
  it('scopes every query to the signed-in user', async () => {
    await getTransactionsPage();
    expect(callsOf('eq')).toContainEqual(['user_id', USER_ID]);
  });

  it('asks for one row past the page so hasMore needs no count query', async () => {
    await getTransactionsPage({ limit: 25, offset: 50 });
    expect(callsOf('range')).toEqual([[50, 75]]);
  });

  it('orders by a total key so offset paging cannot skip or repeat rows', async () => {
    await getTransactionsPage();
    expect(callsOf('order')).toEqual([
      ['date', { ascending: false }],
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it('flips the whole sort when asked for oldest first', async () => {
    await getTransactionsPage({ ascending: true });
    expect(callsOf('order')).toEqual([
      ['date', { ascending: true }],
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('omits filters that were not asked for', async () => {
    await getTransactionsPage();
    expect(callsOf('gte')).toEqual([]);
    expect(callsOf('lte')).toEqual([]);
    expect(callsOf('or')).toEqual([]);
    // Only the user scoping remains.
    expect(callsOf('eq')).toEqual([['user_id', USER_ID]]);
  });

  it('applies the wallet, date, direction and category filters', async () => {
    await getTransactionsPage({
      walletId: WALLET_ID,
      from: '2026-10-01',
      to: '2026-10-31',
      type: 'EXPENSE',
      category: 'Food',
    });

    expect(callsOf('eq')).toEqual([
      ['user_id', USER_ID],
      ['wallet_id', WALLET_ID],
      ['type', 'EXPENSE'],
      ['category', 'Food'],
    ]);
    expect(callsOf('gte')).toEqual([['date', '2026-10-01']]);
    expect(callsOf('lte')).toEqual([['date', '2026-10-31']]);
  });

  it('searches note and category in one or-expression', async () => {
    await getTransactionsPage({ search: 'coffee' });
    expect(callsOf('or')).toEqual([
      ['note.ilike."%coffee%",category.ilike."%coffee%"'],
    ]);
  });

  it('escapes the search term before it reaches the or-expression', async () => {
    await getTransactionsPage({ search: 'lunch, 50%' });
    expect(callsOf('or')).toEqual([
      ['note.ilike."%lunch, 50\\%%",category.ilike."%lunch, 50\\%%"'],
    ]);
  });

  it('normalises the amount column from a numeric string', async () => {
    harness.state.rows = [{ ...row('a'), amount: '1234.50' }];
    const page = await getTransactionsPage();
    expect(page.rows[0]?.amount).toBe(1234.5);
  });

  it('reports hasMore false when the page is not full', async () => {
    harness.state.rows = [row('a'), row('b')];
    const page = await getTransactionsPage({ limit: 5 });
    expect(page.hasMore).toBe(false);
    expect(page.rows).toHaveLength(2);
  });

  it('reports hasMore true and trims the probe row when the page is full', async () => {
    harness.state.rows = [row('a'), row('b'), row('c')];
    const page = await getTransactionsPage({ limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.rows.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('returns an empty page rather than throwing when there is nothing', async () => {
    harness.state.rows = [];
    const page = await getTransactionsPage();
    expect(page).toEqual({ rows: [], hasMore: false });
  });

  it('funnels a PostgREST failure through toAppError', async () => {
    harness.state.error = { code: '42501', message: 'nope' };
    await expect(getTransactionsPage()).rejects.toMatchObject({
      name: 'AppError',
      code: 'permission_denied',
    });
  });

  it('refuses to query when nobody is signed in', async () => {
    harness.state.userId = null;
    await expect(getTransactionsPage()).rejects.toThrowError();
  });

  /* ── Transfer counterparts ─────────────────────────────────────────────── */

  it('costs no extra round trip on a page with no transfers on it', async () => {
    harness.state.rows = [row('a'), row('b')];
    await getTransactionsPage();
    expect(callsOf('from')).toEqual([['transactions']]);
  });

  it('gives each leg the wallet at the other end, not its own', async () => {
    harness.state.rows = [
      { ...row('out'), transfer_group_id: GROUP, wallet_id: WALLET_ID, type: 'EXPENSE' },
      { ...row('in'), transfer_group_id: GROUP, wallet_id: CASH_ID, type: 'INCOME' },
    ];
    harness.state.transferLegs = [
      leg(GROUP, WALLET_ID, 'EXPENSE'),
      leg(GROUP, CASH_ID, 'INCOME'),
    ];

    const { rows } = await getTransactionsPage();

    expect(rows[0]?.transfer_counterpart_wallet_id).toBe(CASH_ID);
    expect(rows[1]?.transfer_counterpart_wallet_id).toBe(WALLET_ID);
  });

  it('looks the pair up by group, so a filtered page still knows the other end', async () => {
    // A wallet-scoped ledger shows one leg and never the other, so the lookup
    // must not inherit the page's filters — otherwise the sibling is invisible
    // and every transfer renders as a single wallet again.
    harness.state.rows = [
      { ...row('out'), transfer_group_id: GROUP, wallet_id: WALLET_ID, type: 'EXPENSE' },
    ];
    harness.state.transferLegs = [
      leg(GROUP, WALLET_ID, 'EXPENSE'),
      leg(GROUP, CASH_ID, 'INCOME'),
    ];

    const { rows } = await getTransactionsPage({ walletId: WALLET_ID });

    expect(rows[0]?.transfer_counterpart_wallet_id).toBe(CASH_ID);
    expect(callsOf('in')).toEqual([['transfer_group_id', [GROUP]]]);
    // The user scoping is repeated on the lookup; the wallet filter is not.
    expect(callsOf('eq')).toEqual([
      ['user_id', USER_ID],
      ['wallet_id', WALLET_ID],
      ['user_id', USER_ID],
    ]);
  });

  it('leaves an ordinary row with no counterpart', async () => {
    harness.state.rows = [row('a')];
    const { rows } = await getTransactionsPage();
    expect(rows[0]?.transfer_counterpart_wallet_id).toBeNull();
  });
});
