import { SalesError } from './salesMath.js';

/** Half-up integer division of non-negative integers: floor(num/den + 1/2). Same formula as StockMath / rules. */
export function halfUpDiv(num, den) {
  const v = Math.floor((2 * num + den) / (2 * den));
  if (!Number.isSafeInteger(v) || !Number.isSafeInteger(2 * num + den)) throw new SalesError('invalid_request', 400);
  return v;
}

/**
 * Spreads a signed integer `adj` over `weights` (non-negative integers, sum > 0) proportionally.
 * Largest-remainder method: the shares always add up to exactly `adj`. BigInt avoids float overflow.
 */
export function spreadSigned(adj, weights) {
  const zeros = weights.map(() => 0);
  if (adj === 0) return zeros;
  const W = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (W === 0n) return zeros;
  const a = BigInt(Math.abs(adj));
  const base = [];
  const rem = [];
  let used = 0n;
  for (const w of weights) {
    const num = a * BigInt(w);
    base.push(num / W);
    rem.push(num % W);
    used += num / W;
  }
  const left = Number(a - used); // always < weights.length
  const order = rem.map((r, i) => i).sort((i, j) => (rem[j] > rem[i] ? 1 : rem[j] < rem[i] ? -1 : i - j));
  for (let k = 0; k < left; k += 1) base[order[k]] += 1n;
  return base.map((b) => Number(adj < 0 ? -b : b));
}

/**
 * Purchase totals. `lines`: [{qty, unitCost}] (integers, minor units).
 * total = subtotal - discount + extraCosts (the whole bill is owed to the supplier).
 * The net adjustment (extraCosts - discount) is spread over the lines in proportion to their value (by quantity
 * when every line is free), so each line gets a *landed* total and the landed totals add up to `total`.
 */
export function computePurchaseTotals(lines, discount, extraCosts, cashPaid) {
  const lineTotals = lines.map((l) => l.qty * l.unitCost);
  const subtotal = lineTotals.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(subtotal)) throw new SalesError('invalid_request', 400);
  if (discount > subtotal) throw new SalesError('discount_too_high', 400);
  const total = subtotal - discount + extraCosts;
  if (!Number.isSafeInteger(total)) throw new SalesError('invalid_request', 400);
  if (cashPaid > total) throw new SalesError('invalid_payment', 400);
  const weights = subtotal > 0 ? lineTotals : lines.map((l) => l.qty);
  const shares = spreadSigned(extraCosts - discount, weights);
  const landedTotals = lineTotals.map((t, i) => t + shares[i]);
  if (landedTotals.some((v) => v < 0)) throw new SalesError('invalid_request', 400); // cannot happen; defensive
  const landedUnitCosts = landedTotals.map((v, i) => halfUpDiv(v, lines[i].qty));
  return { lineTotals, subtotal, total, credit: total - cashPaid, landedTotals, landedUnitCosts };
}

/** Weighted-average cost after receiving `qty` units worth `landedTotal` (empty/negative stock: just the landed unit cost). */
export function avgAfterReceive(stockBefore, avgBefore, qty, landedTotal) {
  if (stockBefore <= 0) return halfUpDiv(landedTotal, qty);
  return halfUpDiv(stockBefore * avgBefore + landedTotal, stockBefore + qty);
}

/**
 * Average after taking a purchase back out: remove its landed value and quantity from the stock value.
 * When nothing remains, fall back to the average that held before the purchase (`fallbackAvg`).
 */
export function avgAfterRemoval(stockBefore, avgBefore, qty, landedTotal, fallbackAvg) {
  const remaining = stockBefore - qty;
  if (remaining <= 0) return fallbackAvg;
  const value = stockBefore * avgBefore - landedTotal;
  return value <= 0 ? 0 : halfUpDiv(value, remaining);
}
