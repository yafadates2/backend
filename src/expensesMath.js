import { SalesError } from './salesMath.js';

export const MAX_EXPENSE_AMOUNT = 100_000_000_000;
export const MAX_BACKDATE_DAYS = 400;

/**
 * Expense date = the day the money went out. Unlike sales it may be in the past (yesterday's electricity bill),
 * but it must be a real date, at most one day ahead of the server's UTC date, and not older than ~13 months.
 */
export function assertExpenseDate(date, nowMs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(t);
    const real = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    const today = Math.floor(nowMs / 86_400_000) * 86_400_000;
    const diffDays = (t - today) / 86_400_000;
    if (real && diffDays <= 1 && diffDays >= -MAX_BACKDATE_DAYS) return;
  }
  throw new SalesError('invalid_business_date', 400);
}

/**
 * Net effect on one day's stats when `before` (an active expense or null) becomes `after` (or null).
 * Returns Map(date -> {count, total}) without zero entries, so an unchanged edit writes nothing.
 */
export function statsDelta(before, after) {
  const out = new Map();
  const bump = (e, sign) => {
    if (!e) return;
    const d = out.get(e.businessDate) ?? { count: 0, total: 0 };
    d.count += sign;
    d.total += sign * e.amount;
    out.set(e.businessDate, d);
  };
  bump(before, -1);
  bump(after, +1);
  for (const [k, v] of out) if (v.count === 0 && v.total === 0) out.delete(k);
  return out;
}
