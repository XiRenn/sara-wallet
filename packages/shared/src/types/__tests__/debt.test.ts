/**
 * The debt domain rules that the UI depends on.
 *
 * Everything here is pure — no database, no network — which is the point:
 * status, urgency and the direction/ledger pairing are the decisions a user
 * actually sees, and they are worth pinning down independently of the SQL that
 * also enforces some of them.
 */

import { describe, expect, it } from 'vitest';

import {
  compareDebts,
  daysUntilDue,
  debtProgress,
  debtStatus,
  defaultSettlementCategory,
  directionForSettlementType,
  isDebtDirection,
  isOverdue,
  normaliseDebt,
  settlementTypeFor,
  toDebtInsert,
  toDebtUpdate,
  type Debt,
} from '../debt';

/** A debt with sane defaults, so each test states only what it is about. */
function debt(patch: Partial<Debt> = {}): Debt {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    user_id: '30000000-0000-4000-8000-000000000001',
    direction: 'RECEIVABLE',
    counterparty: 'Ko Aung',
    currency: 'MMK',
    principal: 50000,
    note: null,
    issued_on: '2026-09-01',
    due_on: '2026-10-20',
    closed_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    settled: 0,
    outstanding: 50000,
    ...patch,
  };
}

/** Local midnight, so the day is unambiguous wherever the suite runs. */
const TODAY = new Date(2026, 9, 14);

/* -------------------------------------------------------------------------- */

describe('settlementTypeFor', () => {
  it('collects a receivable with income and pays a payable with expense', () => {
    expect(settlementTypeFor('RECEIVABLE')).toBe('INCOME');
    expect(settlementTypeFor('PAYABLE')).toBe('EXPENSE');
  });

  it('round-trips through directionForSettlementType', () => {
    expect(directionForSettlementType(settlementTypeFor('RECEIVABLE'))).toBe('RECEIVABLE');
    expect(directionForSettlementType(settlementTypeFor('PAYABLE'))).toBe('PAYABLE');
  });

  it('files settlements under a category that says what they are', () => {
    expect(defaultSettlementCategory('RECEIVABLE')).toBe('Debt collection');
    expect(defaultSettlementCategory('PAYABLE')).toBe('Debt payment');
  });
});

describe('isDebtDirection', () => {
  it('accepts the two enum members', () => {
    expect(isDebtDirection('RECEIVABLE')).toBe(true);
    expect(isDebtDirection('PAYABLE')).toBe(true);
  });

  it('rejects anything else, including the ledger types', () => {
    expect(isDebtDirection('INCOME')).toBe(false);
    expect(isDebtDirection('receivable')).toBe(false);
    expect(isDebtDirection(null)).toBe(false);
    expect(isDebtDirection(undefined)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('daysUntilDue', () => {
  it('counts forward from today', () => {
    expect(daysUntilDue('2026-10-20', TODAY)).toBe(6);
  });

  it('is zero on the due date itself, whatever the time of day', () => {
    // The bug this guards: subtracting raw instants gives a fraction of a day,
    // so "due today" would read as 0 only by luck.
    expect(daysUntilDue('2026-10-14', new Date(2026, 9, 14, 0, 0))).toBe(0);
    expect(daysUntilDue('2026-10-14', new Date(2026, 9, 14, 23, 59))).toBe(0);
  });

  it('goes negative once the date has passed', () => {
    expect(daysUntilDue('2026-10-04', TODAY)).toBe(-10);
  });

  it('is null when there is no agreed date', () => {
    expect(daysUntilDue(null, TODAY)).toBeNull();
  });

  it('accepts a full ISO instant for "today" and keeps its local day', () => {
    expect(daysUntilDue('2026-10-20', '2026-10-14T23:00:00.000Z')).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('debtStatus', () => {
  it('is OPEN for an undated debt, never overdue', () => {
    expect(debtStatus({ closed_at: null, due_on: null, outstanding: 100 }, TODAY)).toBe('OPEN');
    expect(isOverdue({ closed_at: null, due_on: null, outstanding: 100 }, TODAY)).toBe(false);
  });

  it('is OVERDUE once the due date has passed', () => {
    expect(debtStatus({ closed_at: null, due_on: '2026-10-04', outstanding: 1 }, TODAY)).toBe(
      'OVERDUE',
    );
  });

  it('is DUE_SOON inside the window, and OPEN outside it', () => {
    expect(debtStatus({ closed_at: null, due_on: '2026-10-20', outstanding: 1 }, TODAY)).toBe(
      'DUE_SOON',
    );
    expect(debtStatus({ closed_at: null, due_on: '2026-11-30', outstanding: 1 }, TODAY)).toBe(
      'OPEN',
    );
  });

  it('treats the due date itself as due soon, not overdue', () => {
    expect(debtStatus({ closed_at: null, due_on: '2026-10-14', outstanding: 1 }, TODAY)).toBe(
      'DUE_SOON',
    );
  });

  it('is SETTLED when nothing is outstanding', () => {
    expect(debtStatus({ closed_at: null, due_on: '2026-09-01', outstanding: 0 }, TODAY)).toBe(
      'SETTLED',
    );
  });

  it('prefers CLOSED over every other reading', () => {
    // A written-off debt that is also overdue and partly unpaid is CLOSED —
    // the user has said to stop counting it.
    const closed = { closed_at: '2026-10-01T00:00:00.000Z', due_on: '2026-09-01', outstanding: 500 };
    expect(debtStatus(closed, TODAY)).toBe('CLOSED');
    expect(isOverdue(closed, TODAY)).toBe(false);
  });

  it('tolerates a money column arriving as a string', () => {
    const stringy = { closed_at: null, due_on: null, outstanding: '0' as unknown as number };
    expect(debtStatus(stringy, TODAY)).toBe('SETTLED');
  });
});

/* -------------------------------------------------------------------------- */

describe('debtProgress', () => {
  it('is the settled share of the principal', () => {
    expect(debtProgress({ principal: 50000, settled: 20000 })).toBeCloseTo(0.4);
  });

  it('is 0 for an untouched debt and 1 for a fully settled one', () => {
    expect(debtProgress({ principal: 50000, settled: 0 })).toBe(0);
    expect(debtProgress({ principal: 50000, settled: 50000 })).toBe(1);
  });

  it('clamps rather than exceeding 1 if the rows ever disagree', () => {
    expect(debtProgress({ principal: 50000, settled: 60000 })).toBe(1);
  });

  it('does not divide by zero on a malformed principal', () => {
    expect(debtProgress({ principal: 0, settled: 100 })).toBe(0);
    expect(debtProgress({ principal: -5, settled: 100 })).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('normaliseDebt', () => {
  it('coerces numeric strings on every money field', () => {
    const row = {
      ...debt(),
      principal: '50000' as unknown as number,
      settled: '20000' as unknown as number,
      outstanding: '30000' as unknown as number,
    };
    const result = normaliseDebt(row);
    expect(result.principal).toBe(50000);
    expect(result.settled).toBe(20000);
    expect(result.outstanding).toBe(30000);
  });

  it('leaves a non-numeric value at 0 rather than NaN', () => {
    const row = { ...debt(), outstanding: 'not a number' as unknown as number };
    expect(normaliseDebt(row).outstanding).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('compareDebts', () => {
  it('puts overdue above due-soon above open', () => {
    const overdue = debt({ id: 'a', due_on: '2026-10-01' });
    const dueSoon = debt({ id: 'b', due_on: '2026-10-18' });
    const later = debt({ id: 'c', due_on: '2026-12-01' });

    const sorted = [later, dueSoon, overdue].sort((a, b) => compareDebts(a, b, TODAY));
    expect(sorted.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts undated debts last rather than as if they were due in 1970', () => {
    const undated = debt({ id: 'undated', due_on: null });
    const later = debt({ id: 'later', due_on: '2026-12-01' });

    const sorted = [undated, later].sort((a, b) => compareDebts(a, b, TODAY));
    expect(sorted.map((d) => d.id)).toEqual(['later', 'undated']);
  });

  it('breaks a due-date tie by counterparty, so the order is stable', () => {
    const zebra = debt({ id: 'z', counterparty: 'Zebra', due_on: '2026-10-20' });
    const apple = debt({ id: 'a', counterparty: 'Apple', due_on: '2026-10-20' });

    const sorted = [zebra, apple].sort((a, b) => compareDebts(a, b, TODAY));
    expect(sorted.map((d) => d.id)).toEqual(['a', 'z']);
  });

  it('sinks settled and closed debts below open ones', () => {
    const settled = debt({ id: 'settled', outstanding: 0, settled: 50000, due_on: '2026-10-01' });
    const closed = debt({ id: 'closed', closed_at: '2026-10-01T00:00:00.000Z' });
    const open = debt({ id: 'open', due_on: '2026-12-01' });

    const sorted = [settled, closed, open].sort((a, b) => compareDebts(a, b, TODAY));
    expect(sorted.map((d) => d.id)).toEqual(['open', 'settled', 'closed']);
  });
});

/* -------------------------------------------------------------------------- */

describe('toDebtInsert', () => {
  const userId = '30000000-0000-4000-8000-000000000001';

  it('stamps the owner and trims the free text', () => {
    const payload = toDebtInsert(
      { direction: 'RECEIVABLE', counterparty: '  Ko Aung  ', principal: 50000 },
      userId,
    );
    expect(payload.user_id).toBe(userId);
    expect(payload.counterparty).toBe('Ko Aung');
  });

  it('reduces dates to a calendar day, not an instant', () => {
    // A full ISO instant handed to a `date` column lets the server choose the
    // day — which is a different day for a user in a negative-offset zone.
    const payload = toDebtInsert(
      {
        direction: 'PAYABLE',
        counterparty: 'Daw Hla',
        principal: 30000,
        issuedOn: new Date(2026, 9, 1, 23, 30),
        dueOn: new Date(2026, 9, 20, 23, 30),
      },
      userId,
    );
    expect(payload.issued_on).toBe('2026-10-01');
    expect(payload.due_on).toBe('2026-10-20');
  });

  it('passes a date-only string through untouched', () => {
    const payload = toDebtInsert(
      {
        direction: 'PAYABLE',
        counterparty: 'Daw Hla',
        principal: 30000,
        issuedOn: '2026-10-01',
        dueOn: '2026-10-20',
      },
      userId,
    );
    expect(payload.issued_on).toBe('2026-10-01');
    expect(payload.due_on).toBe('2026-10-20');
  });

  it('stores an omitted due date as an explicit null, not "today"', () => {
    const payload = toDebtInsert(
      { direction: 'RECEIVABLE', counterparty: 'Nok', principal: 1000 },
      userId,
    );
    expect(payload.due_on).toBeNull();
  });

  it('turns a blank note into null rather than an empty string', () => {
    const payload = toDebtInsert(
      { direction: 'RECEIVABLE', counterparty: 'Nok', principal: 1000, note: '   ' },
      userId,
    );
    expect(payload.note).toBeNull();
  });
});

describe('toDebtUpdate', () => {
  it('carries only the keys the caller actually set', () => {
    expect(toDebtUpdate({ counterparty: 'Daw Hla (shop)' })).toEqual({
      counterparty: 'Daw Hla (shop)',
    });
  });

  it('distinguishes "clear the due date" from "leave it alone"', () => {
    expect(toDebtUpdate({ dueOn: null })).toEqual({ due_on: null });
    expect(toDebtUpdate({})).toEqual({});
  });

  it('normalises a blank note to null', () => {
    expect(toDebtUpdate({ note: '  ' })).toEqual({ note: null });
  });

  it('reduces a Date due date to a calendar day', () => {
    expect(toDebtUpdate({ dueOn: new Date(2026, 9, 20, 23, 30) })).toEqual({ due_on: '2026-10-20' });
  });
});
