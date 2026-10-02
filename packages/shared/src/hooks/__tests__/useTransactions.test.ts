/**
 * `mergeTransactionPages` is the one piece of the pagination hook that can be
 * tested without a renderer, and it is also the piece that carries the real
 * risk: offset paging can hand the same row back twice.
 *
 * The hook itself needs a DOM renderer to exercise, which this package does
 * not depend on. Everything else it does is either a thin `useState` wrapper
 * or lives in `getTransactionsPage`, which has its own suite.
 */

import { describe, expect, it } from 'vitest';

import type { Transaction } from '../../services/transaction';
import { mergeTransactionPages } from '../useTransactions';

function transaction(id: string): Transaction {
  return {
    id,
    wallet_id: '22222222-2222-4222-8222-222222222222',
    user_id: '11111111-1111-4111-8111-111111111111',
    type: 'EXPENSE',
    amount: 10,
    category: 'Food',
    note: null,
    date: '2026-10-01',
    created_at: '2026-10-01T00:00:00.000Z',
    transfer_group_id: null,
    transfer_counterpart_wallet_id: null,
    debt_id: null,
  };
}

const ids = (rows: readonly Transaction[]) => rows.map((row) => row.id);

describe('mergeTransactionPages', () => {
  it('appends the incoming page in order', () => {
    const merged = mergeTransactionPages(
      [transaction('a'), transaction('b')],
      [transaction('c'), transaction('d')],
    );
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops rows that are already on screen', () => {
    // What a write landing between two requests looks like: the page boundary
    // shifts and the last row of page 1 reappears at the top of page 2.
    const merged = mergeTransactionPages(
      [transaction('a'), transaction('b'), transaction('c')],
      [transaction('c'), transaction('d')],
    );
    expect(ids(merged)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the existing row, not the duplicate', () => {
    const original = transaction('a');
    const merged = mergeTransactionPages([original], [transaction('a')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(original);
  });

  it('returns a copy rather than mutating the input', () => {
    const existing = [transaction('a')];
    const merged = mergeTransactionPages(existing, [transaction('b')]);
    expect(existing).toHaveLength(1);
    expect(merged).not.toBe(existing);
  });

  it('handles an empty page and an empty list', () => {
    expect(ids(mergeTransactionPages([], []))).toEqual([]);
    expect(ids(mergeTransactionPages([transaction('a')], []))).toEqual(['a']);
    expect(ids(mergeTransactionPages([], [transaction('a')]))).toEqual(['a']);
  });

  it('carries the transfer counterpart through a page merge', () => {
    // `loadMore` merges pages, and a leg that lost its counterpart mid-scroll
    // would silently collapse back to a single-wallet row.
    const leg: Transaction = {
      ...transaction('a'),
      transfer_group_id: '33333333-3333-4333-8333-333333333333',
      transfer_counterpart_wallet_id: '44444444-4444-4444-8444-444444444444',
    };
    const merged = mergeTransactionPages([], [leg]);
    expect(merged[0]?.transfer_counterpart_wallet_id).toBe(
      '44444444-4444-4444-8444-444444444444',
    );
  });
});
