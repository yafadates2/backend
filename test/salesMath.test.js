import { describe, it, expect } from 'vitest';
import {
  SalesError, allocateFifo, assertBusinessDate, computeTotals, fingerprint, formatNumber,
} from '../src/salesMath.js';

const code = (fn) => { try { fn(); } catch (e) { return e instanceof SalesError ? e.code : `other:${e}`; } return null; };

describe('computeTotals', () => {
  it('sums lines, applies the discount, splits cash and credit', () => {
    const t = computeTotals([{ qty: 2, unitPrice: 18000 }, { qty: 1, unitPrice: 6500 }], 1500, 20000);
    expect(t.lineTotals).toEqual([36000, 6500]);
    expect(t.subtotal).toBe(42500);
    expect(t.total).toBe(41000);
    expect(t.credit).toBe(21000);
  });
  it('rejects a discount above the subtotal', () => {
    expect(code(() => computeTotals([{ qty: 1, unitPrice: 1000 }], 1001, 0))).toBe('discount_too_high');
  });
  it('rejects paying more than the total', () => {
    expect(code(() => computeTotals([{ qty: 1, unitPrice: 1000 }], 0, 1001))).toBe('invalid_payment');
  });
  it('allows a free sale (100% discount)', () => {
    expect(computeTotals([{ qty: 1, unitPrice: 1000 }], 1000, 0).total).toBe(0);
  });
});

describe('allocateFifo', () => {
  const open = [{ id: 'a', remaining: 5000 }, { id: 'b', remaining: 3000 }, { id: 'c', remaining: 9000 }];
  it('settles the oldest first and stops', () => {
    expect(allocateFifo(open, 6000)).toEqual({ allocations: [{ saleId: 'a', amount: 5000 }, { saleId: 'b', amount: 1000 }], leftover: 0 });
  });
  it('pays everything exactly', () => {
    const r = allocateFifo(open, 17000);
    expect(r.allocations.map((a) => a.amount)).toEqual([5000, 3000, 9000]);
    expect(r.leftover).toBe(0);
  });
  it('reports what could not be placed', () => {
    expect(allocateFifo(open, 18000).leftover).toBe(1000);
  });
});

describe('helpers', () => {
  it('fingerprint ignores key order but not content', () => {
    expect(fingerprint({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(fingerprint({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
  it('formats numbers', () => {
    expect(formatNumber('TY', 7)).toBe('TY-000007');
  });
  it('accepts today and neighbours, rejects far or fake dates', () => {
    const now = Date.UTC(2026, 10, 3, 12);
    expect(code(() => assertBusinessDate('2026-11-03', now))).toBeNull();
    expect(code(() => assertBusinessDate('2026-11-04', now))).toBeNull();
    expect(code(() => assertBusinessDate('2026-11-02', now))).toBeNull();
    expect(code(() => assertBusinessDate('2026-10-30', now))).toBe('invalid_business_date');
    expect(code(() => assertBusinessDate('2026-02-30', now))).toBe('invalid_business_date');
    expect(code(() => assertBusinessDate('nope', now))).toBe('invalid_business_date');
  });
});
