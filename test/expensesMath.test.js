import { describe, it, expect } from 'vitest';
import { assertExpenseDate, statsDelta } from '../src/expensesMath.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const bad = (d) => { try { assertExpenseDate(d, NOW); } catch (e) { return e.code; } return null; };

describe('assertExpenseDate', () => {
  it('accepts today, tomorrow and past days', () => {
    for (const d of ['2026-11-03', '2026-11-04', '2026-10-01', '2025-10-30']) expect(bad(d)).toBe(null);
  });
  it('rejects the far future, very old, malformed and impossible dates', () => {
    for (const d of ['2026-11-05', '2025-01-01', '2026-02-30', '2026-13-01', 'x', '', null, '03-11-2026']) {
      expect(bad(d)).toBe('invalid_business_date');
    }
  });
});

describe('statsDelta', () => {
  const e = (businessDate, amount) => ({ businessDate, amount });
  it('create adds, archive removes', () => {
    expect([...statsDelta(null, e('d1', 500))]).toEqual([['d1', { count: 1, total: 500 }]]);
    expect([...statsDelta(e('d1', 500), null)]).toEqual([['d1', { count: -1, total: -500 }]]);
  });
  it('same day amount change = net total only', () => {
    expect([...statsDelta(e('d1', 500), e('d1', 800))]).toEqual([['d1', { count: 0, total: 300 }]]);
  });
  it('date change moves the amount between days', () => {
    const m = statsDelta(e('d1', 500), e('d2', 500));
    expect(m.get('d1')).toEqual({ count: -1, total: -500 });
    expect(m.get('d2')).toEqual({ count: 1, total: 500 });
  });
  it('no change = empty', () => {
    expect(statsDelta(e('d1', 500), e('d1', 500)).size).toBe(0);
  });
});
