import { createHash } from 'node:crypto';

export const MAX_LINES = 50;
export const MAX_OPEN_SALES_PER_PAYMENT = 200;

/** Business error with a stable machine code (the Flutter app maps codes to localised text). */
export class SalesError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Order-independent hash of a plain JSON-like value (idempotency: same id + other content = conflict). */
export function fingerprint(value) {
  const canon = (v) => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return createHash('sha256').update(canon(value)).digest('hex');
}

/** `businessDate` is the client's local date; accept only a real date within one day of the server's UTC date. */
export function assertBusinessDate(date, nowMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    const real = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    const today = Math.floor(nowMs / 86_400_000) * 86_400_000;
    if (real && Math.abs(t - today) <= 86_400_000) return;
  }
  throw new SalesError('invalid_business_date', 400);
}

export const formatNumber = (prefix, n, width = 6) => `${prefix}-${String(n).padStart(width, '0')}`;

/**
 * Totals from snapshot prices. `lines`: [{qty, unitPrice}] (integers, minor units).
 * discount is a bill-level amount; cashPaid is what is paid now; the rest is credit.
 */
export function computeTotals(lines, discount, cashPaid) {
  const lineTotals = lines.map((l) => l.qty * l.unitPrice);
  const subtotal = lineTotals.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(subtotal)) throw new SalesError('invalid_request', 400);
  if (discount > subtotal) throw new SalesError('discount_too_high', 400);
  const total = subtotal - discount;
  if (cashPaid > total) throw new SalesError('invalid_payment', 400);
  return { lineTotals, subtotal, total, credit: total - cashPaid };
}

/**
 * FIFO: spread `amount` over open sales (already ordered oldest first).
 * Returns the allocations and whatever could not be placed.
 */
export function allocateFifo(openSales, amount) {
  let left = amount;
  const allocations = [];
  for (const s of openSales) {
    if (left <= 0) break;
    const a = Math.min(left, s.remaining);
    if (a > 0) {
      allocations.push({ saleId: s.id, amount: a });
      left -= a;
    }
  }
  return { allocations, leftover: left };
}
