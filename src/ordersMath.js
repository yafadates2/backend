/** Customer orders: statuses and pure helpers (no I/O, unit-tested). */
export const STATUSES = ['pending', 'available', 'notified', 'completed', 'cancelled'];
/** Orders in these states are still "open": editable, cancellable, completable. */
export const OPEN_STATUSES = ['pending', 'available', 'notified'];
/** Only these are re-checked against stock (a `notified` order was already acted on by the admin). */
export const WATCHED_STATUSES = ['pending', 'available'];

export const isOpen = (status) => OPEN_STATUSES.includes(status);

/** Product ids to watch for stock changes; empty once the order is not pending/available (so queries skip it). */
export const watchedIds = (status, lines) =>
  WATCHED_STATUSES.includes(status) ? lines.map((l) => l.productId) : [];

/**
 * Are ALL requested quantities on hand? Each order is judged on its own against current stock
 * (stock is not reserved: two orders for the same last units can both show as available).
 * A missing or archived product counts as unavailable.
 * `products`: Map productId -> { stockQty, isActive }.
 */
export function evaluateAvailability(lines, products) {
  const shortages = [];
  for (const l of lines) {
    const p = products.get(l.productId);
    const stock = Number.isSafeInteger(p?.stockQty) ? p.stockQty : 0;
    if (!p || p.isActive === false || stock < l.qty) {
      shortages.push({ productId: l.productId, needed: l.qty, have: Math.max(stock, 0) });
    }
  }
  return { allAvailable: shortages.length === 0, shortages };
}

/** Real calendar date `yyyy-MM-dd` (not just the right shape), within a sane range. */
export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (y < 2020 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
