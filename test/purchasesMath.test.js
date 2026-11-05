import { describe, it, expect } from 'vitest';
import { spreadSigned, computePurchaseTotals, avgAfterReceive, avgAfterRemoval, halfUpDiv } from '../src/purchasesMath.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

describe('spreadSigned', () => {
  it('always adds up exactly to the adjustment', () => {
    for (const adj of [0, 1, 7, 100, -1, -7, -100, 12345, -12345]) {
      for (const w of [[1, 1, 1], [10000, 3333, 1], [5, 0, 5], [999999, 1]]) {
        const s = spreadSigned(adj, w);
        expect(sum(s)).toBe(adj);
        expect(s.every((v) => (adj >= 0 ? v >= 0 : v <= 0))).toBe(true);
      }
    }
  });
  it('is proportional and gives remainders to the largest fractions', () => {
    expect(spreadSigned(100, [3, 1])).toEqual([75, 25]);
    expect(spreadSigned(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(spreadSigned(-10, [1, 1, 1])).toEqual([-4, -3, -3]);
  });
  it('does not lose precision on large values', () => {
    const s = spreadSigned(99_999_999_999, [100_000_000_000, 100_000_000_000, 3]);
    expect(sum(s)).toBe(99_999_999_999);
  });
});

describe('computePurchaseTotals', () => {
  const lines = [{ qty: 10, unitCost: 4000 }, { qty: 5, unitCost: 2000 }]; // 40000 + 10000
  it('plain bill: landed = invoice', () => {
    const t = computePurchaseTotals(lines, 0, 0, 20000);
    expect(t).toMatchObject({ subtotal: 50000, total: 50000, credit: 30000, landedTotals: [40000, 10000], landedUnitCosts: [4000, 2000] });
  });
  it('extra costs raise the bill and the unit costs proportionally', () => {
    const t = computePurchaseTotals(lines, 0, 5000, 0);
    expect(t.total).toBe(55000);
    expect(t.landedTotals).toEqual([44000, 11000]);
    expect(t.landedUnitCosts).toEqual([4400, 2200]);
    expect(sum(t.landedTotals)).toBe(t.total);
  });
  it('discount lowers the bill and the unit costs; discount + extra net out', () => {
    expect(computePurchaseTotals(lines, 5000, 0, 0)).toMatchObject({ total: 45000, landedTotals: [36000, 9000] });
    const t = computePurchaseTotals(lines, 2000, 3000, 0);
    expect(t.total).toBe(51000);
    expect(sum(t.landedTotals)).toBe(51000);
  });
  it('rejects discount above subtotal and over-payment; free lines spread by quantity', () => {
    expect(() => computePurchaseTotals(lines, 50001, 0, 0)).toThrow(/discount_too_high/);
    expect(() => computePurchaseTotals(lines, 0, 0, 50001)).toThrow(/invalid_payment/);
    const free = computePurchaseTotals([{ qty: 3, unitCost: 0 }, { qty: 1, unitCost: 0 }], 0, 400, 0);
    expect(free.landedTotals).toEqual([300, 100]);
  });
  it('full discount makes a free bill without negative lines', () => {
    const t = computePurchaseTotals(lines, 50000, 0, 0);
    expect(t.total).toBe(0);
    expect(t.landedTotals).toEqual([0, 0]);
  });
});

describe('average cost', () => {
  it('matches the app formula (half up) when receiving', () => {
    expect(avgAfterReceive(10, 4000, 10, 5000)).toBe(0 + halfUpDiv(10 * 4000 + 5000, 20)); // landed total 5000 for 10 units
    expect(avgAfterReceive(10, 4000, 10, 60000)).toBe(5000);
    expect(avgAfterReceive(0, 0, 4, 10001)).toBe(2500); // 2500.25 -> 2500
    expect(avgAfterReceive(-3, 999, 4, 10002)).toBe(2501); // empty/negative stock: landed unit cost, 2500.5 -> 2501
  });
  it('removal restores the average when nothing else changed', () => {
    const after = avgAfterReceive(10, 4000, 10, 60000); // 5000 on 20 units
    expect(avgAfterRemoval(20, after, 10, 60000, 4000)).toBe(4000);
  });
  it('falls back when the stock becomes empty and never goes negative', () => {
    expect(avgAfterRemoval(10, 5000, 10, 50000, 4200)).toBe(4200);
    expect(avgAfterRemoval(15, 100, 10, 999999, 0)).toBe(0);
  });
});
