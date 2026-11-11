import { describe, it, expect } from 'vitest';
import { evaluateAvailability, watchedIds, isRealDate, isOpen } from '../src/ordersMath.js';

const stock = (o) => new Map(Object.entries(o));

describe('evaluateAvailability', () => {
  const lines = [{ productId: 'a', qty: 2 }, { productId: 'b', qty: 1 }];
  it('all lines covered -> available', () => {
    expect(evaluateAvailability(lines, stock({ a: { stockQty: 2 }, b: { stockQty: 5 } })).allAvailable).toBe(true);
  });
  it('one short line -> not available, with the shortage', () => {
    const r = evaluateAvailability(lines, stock({ a: { stockQty: 1 }, b: { stockQty: 5 } }));
    expect(r.allAvailable).toBe(false);
    expect(r.shortages).toEqual([{ productId: 'a', needed: 2, have: 1 }]);
  });
  it('missing, archived and negative-stock products are unavailable', () => {
    expect(evaluateAvailability(lines, stock({ a: { stockQty: 9 } })).allAvailable).toBe(false);
    expect(evaluateAvailability(lines, stock({ a: { stockQty: 9, isActive: false }, b: { stockQty: 9 } })).allAvailable).toBe(false);
    expect(evaluateAvailability([{ productId: 'a', qty: 1 }], stock({ a: { stockQty: -3 } })).shortages[0].have).toBe(0);
  });
});

describe('helpers', () => {
  it('only pending/available orders are watched', () => {
    const l = [{ productId: 'a' }];
    expect(watchedIds('pending', l)).toEqual(['a']);
    expect(watchedIds('available', l)).toEqual(['a']);
    for (const s of ['notified', 'completed', 'cancelled']) expect(watchedIds(s, l)).toEqual([]);
  });
  it('open statuses', () => {
    expect(['pending', 'available', 'notified'].every(isOpen)).toBe(true);
    expect(isOpen('completed') || isOpen('cancelled')).toBe(false);
  });
  it('isRealDate rejects impossible dates', () => {
    expect(isRealDate('2026-11-30')).toBe(true);
    for (const d of ['2026-02-30', '2026-13-01', '20-01-01', '1999-01-01', null, 'x']) expect(isRealDate(d)).toBe(false);
  });
});
