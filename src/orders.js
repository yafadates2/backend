import { SalesError, MAX_LINES, assertBusinessDate, fingerprint, formatNumber } from './salesMath.js';
import { evaluateAvailability, watchedIds, isOpen, isRealDate } from './ordersMath.js';
import { businessDateAt } from './reminders.js';

/**
 * Customer orders: requests the shop admin records for customers who have no account.
 *
 * Rules this service guarantees:
 *  - Creating / editing / cancelling an order never touches stock and never creates a sale.
 *  - Stock moves ONLY in `completeOrder`, which creates the sale through the existing sales service
 *    (`planSale`) inside the SAME transaction that flips the order to `completed`. Reads happen first, so a
 *    double tap or a retry sees `completed` (or the existing sale) and can never sell twice.
 *  - Availability checks flip `pending -> available` exactly once per event (the flip is a transaction on the
 *    order document; only the transaction that performs it asks for a push).
 *  - `customer_orders` is written ONLY here (Admin SDK); rules keep it read-only for apps.
 *
 *  - The "expected today" reminder is sent at most once per order and expected date: the order document records the
 *    date it was reminded for (`expectedReminderFor`), claimed in a transaction BEFORE the push goes out.
 *
 * `sales` is the sales service (needs `planSale`); `notifier` sends the pushes (`orderAvailable(order)`,
 * `orderExpectedToday(order)`).
 */
export function createOrdersService({ db, fieldValue, sales, notifier, logger, now = () => Date.now() }) {
  const orders = () => db.collection('customer_orders');
  const orderRef = (id) => orders().doc(id);
  const productRef = (id) => db.collection('products').doc(id);
  const settingsRef = db.collection('shop_settings').doc('main');
  const counterRef = db.collection('counters').doc('customer_orders');
  const ts = () => fieldValue.serverTimestamp();
  const inc = (n) => fieldValue.increment(n);
  const int = (v) => (Number.isSafeInteger(v) ? v : 0);
  const CHUNK = 30; // Firestore array-contains-any limit

  const summary = (snap, duplicate = false) => ({
    id: snap.id,
    number: snap.get('number'),
    status: snap.get('status'),
    total: snap.get('total'),
    duplicate,
  });

  const stockMap = (productIds, snaps) => {
    const m = new Map();
    productIds.forEach((id, i) => {
      const p = snaps[i];
      if (p.exists) m.set(id, { stockQty: int(p.get('stockQty')), isActive: p.get('isActive') !== false });
    });
    return m;
  };

  async function sendPush(order) {
    try {
      await notifier?.orderAvailable(order);
    } catch (err) {
      logger?.error({ err, orderId: order.id }, 'availability push failed'); // the order is already `available` in the app
    }
  }

  /**
   * Re-judge ONE order against current stock, in a transaction.
   * pending -> available (+1 availability event, push asked once) ; available -> pending when stock fell again.
   * Returns 'available' | 'pending' | null (null = unchanged / not watched).
   */
  async function reevaluate(orderId) {
    let pushOrder = null;
    const change = await db.runTransaction(async (tx) => {
      pushOrder = null;
      const snap = await tx.get(orderRef(orderId));
      if (!snap.exists) return null;
      const status = snap.get('status');
      if (status !== 'pending' && status !== 'available') return null;
      const lines = snap.get('lines') ?? [];
      const ids = lines.map((l) => l.productId);
      const pSnaps = ids.length ? await tx.getAll(...ids.map(productRef)) : [];
      const { allAvailable } = evaluateAvailability(lines, stockMap(ids, pSnaps));

      if (status === 'pending' && allAvailable) {
        const events = int(snap.get('availabilityEvents')) + 1;
        tx.update(orderRef(orderId), {
          status: 'available', availableAt: ts(), availabilityEvents: events, updatedAt: ts(),
        });
        pushOrder = {
          id: orderId, number: snap.get('number'), customerName: snap.get('customerName'),
          lines: lines.map((l) => ({ productName: l.productName, qty: l.qty })), event: events,
        };
        return 'available';
      }
      if (status === 'available' && !allAvailable) {
        tx.update(orderRef(orderId), { status: 'pending', availableAt: null, updatedAt: ts() });
        return 'pending';
      }
      return null;
    });
    if (change === 'available' && pushOrder) await sendPush(pushOrder);
    return change;
  }

  async function reevaluateMany(ids) {
    let becameAvailable = 0;
    let backToPending = 0;
    for (const id of ids) {
      try {
        const r = await reevaluate(id);
        if (r === 'available') becameAvailable += 1;
        if (r === 'pending') backToPending += 1;
      } catch (err) {
        logger?.error({ err, orderId: id }, 'availability check failed for order');
      }
    }
    return { checked: ids.length, becameAvailable, backToPending };
  }

  /**
   * Claims today's reminder for ONE order: in a transaction, checks it is still open, still expected `date`, and not
   * reminded for `date` yet, then records `expectedReminderFor = date`. Only the caller that wins gets the order
   * back (racing jobs / instances / restarts get null), so each order is reminded once per expected date.
   * Closed orders (completed / cancelled) are never claimed. Changing the expected date later makes a new date
   * eligible; changing it back to a date already reminded does not repeat the push.
   */
  async function claimReminder(orderId, date) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef(orderId));
      if (!snap.exists) return null;
      if (!isOpen(snap.get('status')) || snap.get('expectedDate') !== date) return null;
      if (snap.get('expectedReminderFor') === date) return null;
      tx.update(orderRef(orderId), { expectedReminderFor: date, expectedReminderAt: ts() });
      return {
        id: orderId, number: snap.get('number'), customerName: snap.get('customerName'), expectedDate: date,
        lines: (snap.get('lines') ?? []).map((l) => ({ productName: l.productName, qty: l.qty })),
      };
    });
  }

  /** Nobody could be reached (no device, or the push service was down): give the claim back so a later run retries. */
  async function releaseReminder(orderId, date) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef(orderId));
      if (snap.exists && snap.get('expectedReminderFor') === date) {
        tx.update(orderRef(orderId), { expectedReminderFor: null, expectedReminderAt: null });
      }
    });
  }

  /** Orders still pending/available that contain any of these products. */
  async function watchingOrderIds(productIds) {
    const unique = [...new Set(productIds)];
    const found = new Set();
    for (let i = 0; i < unique.length; i += CHUNK) {
      const snap = await orders().where('watchProductIds', 'array-contains-any', unique.slice(i, i + CHUNK)).get();
      snap.docs.forEach((d) => found.add(d.id));
    }
    return [...found];
  }

  function loadOpen(tx, id) {
    return tx.get(orderRef(id)).then((snap) => {
      if (!snap.exists) throw new SalesError('order_not_found', 404);
      return snap;
    });
  }

  /** Affected products changed stock (purchase, void, sale, adjustment): re-check the orders that contain them. */
  async function checkProducts(productIds) {
    if (!productIds?.length) return { checked: 0, becameAvailable: 0, backToPending: 0 };
    return reevaluateMany(await watchingOrderIds(productIds));
  }

  return {
    checkProducts,

    /** Safety net (app start): every pending/available order. */
    async checkAll() {
      const ids = new Set();
      for (const status of ['pending', 'available']) {
        const snap = await orders().where('status', '==', status).get();
        snap.docs.forEach((d) => ids.add(d.id));
      }
      return reevaluateMany([...ids]);
    },

    /**
     * Morning reminder: one push for every OPEN order (pending, available or notified; never completed or cancelled)
     * whose expected date is today in the shop's time zone, regardless of its stock. Safe to run any number of times
     * a day (see claimReminder). Returns { date, due, sent, skipped, undelivered }:
     * `skipped` = already reminded / no longer eligible, `undelivered` = claim released for a retry.
     */
    async sendDueReminders() {
      const date = businessDateAt(now());
      const snap = await orders().where('expectedDate', '==', date).get();
      let sent = 0; let skipped = 0; let undelivered = 0;
      for (const d of snap.docs) {
        let claimed = null;
        try {
          claimed = await claimReminder(d.id, date);
          if (!claimed) { skipped += 1; continue; }
          const res = await notifier?.orderExpectedToday(claimed);
          if ((res?.sent ?? 0) > 0) { sent += 1; continue; }
          throw new Error('no device reached');
        } catch (err) {
          if (!claimed) { logger?.error({ err, orderId: d.id }, 'reminder claim failed'); undelivered += 1; continue; }
          undelivered += 1;
          logger?.warn({ err, orderId: d.id }, 'reminder not delivered; will retry');
          await releaseReminder(d.id, date).catch((e) => logger?.error({ err: e, orderId: d.id }, 'reminder release failed'));
        }
      }
      return { date, due: snap.docs.length, sent, skipped, undelivered };
    },

    /** input: {orderId, customerName, customerPhone, lines:[{productId, qty, unitPrice?}], expectedDate|null, notes} */
    async createOrder(uid, input) {
      const { orderId, customerName, customerPhone, lines } = input;
      const expectedDate = input.expectedDate ?? null;
      const notes = input.notes ?? '';
      if (lines.length < 1 || lines.length > MAX_LINES) throw new SalesError('invalid_request', 400);
      const ids = lines.map((l) => l.productId);
      if (new Set(ids).size !== ids.length) throw new SalesError('duplicate_product', 400);
      if (expectedDate !== null && !isRealDate(expectedDate)) throw new SalesError('invalid_expected_date', 400);
      const fp = fingerprint({
        customerName, customerPhone, expectedDate, notes,
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice ?? null })),
      });

      return db.runTransaction(async (tx) => {
        const snaps = await tx.getAll(orderRef(orderId), settingsRef, counterRef, ...ids.map(productRef));
        const [orderSnap, settingsSnap, counterSnap] = snaps;
        const pSnaps = snaps.slice(3);
        if (orderSnap.exists) {
          if (orderSnap.get('fingerprint') !== fp) throw new SalesError('idempotency_conflict', 409);
          return summary(orderSnap, true);
        }
        const priced = lines.map((l, i) => {
          const p = pSnaps[i];
          if (!p.exists) throw new SalesError('product_not_found', 404);
          if (p.get('isActive') === false) throw new SalesError('product_inactive', 409);
          return {
            productId: p.id,
            productName: p.get('name') ?? '',
            qty: l.qty,
            unitPrice: l.unitPrice ?? int(p.get('sellingPrice')), // price at the time of the order
          };
        });
        const total = priced.reduce((a, l) => a + l.qty * l.unitPrice, 0);
        if (!Number.isSafeInteger(total)) throw new SalesError('invalid_request', 400);

        const { allAvailable } = evaluateAvailability(priced, stockMap(ids, pSnaps));
        const status = allAvailable ? 'available' : 'pending';
        const prefix = (settingsSnap.exists && settingsSnap.get('invoicePrefix')) || 'TY';
        const seq = int(counterSnap.get('value')) + 1;
        const number = formatNumber(`${prefix}-O`, seq);

        // NO stock movement, NO sale: an order is only a request.
        tx.create(orderRef(orderId), {
          number, fingerprint: fp,
          customerName, customerPhone,
          lines: priced, lineCount: priced.length, total,
          expectedDate, notes,
          status, isOpen: true,
          watchProductIds: watchedIds(status, priced),
          availabilityEvents: allAvailable ? 1 : 0,
          availableAt: allAvailable ? ts() : null,
          notifiedAt: null, completedAt: null, cancelledAt: null,
          saleId: null, saleNumber: null,
          createdBy: uid, createdAt: ts(), updatedAt: ts(),
        });
        tx.set(counterRef, { value: seq });
        return { id: orderId, number, status, total, duplicate: false };
      });
    },

    /** Edit contact details, expected date and notes while the order is open. Lines are not editable (cancel and re-create). */
    async updateOrder(uid, orderId, patch) {
      if (patch.expectedDate != null && !isRealDate(patch.expectedDate)) throw new SalesError('invalid_expected_date', 400);
      return db.runTransaction(async (tx) => {
        const snap = await loadOpen(tx, orderId);
        if (!isOpen(snap.get('status'))) throw new SalesError('order_closed', 409);
        const data = { updatedAt: ts() };
        for (const k of ['customerName', 'customerPhone', 'expectedDate', 'notes']) {
          if (patch[k] !== undefined) data[k] = patch[k];
        }
        tx.update(orderRef(orderId), data);
        return summary(snap);
      });
    },

    /** available -> notified (the admin has contacted, or is about to contact, the customer). */
    async markNotified(uid, orderId) {
      return db.runTransaction(async (tx) => {
        const snap = await loadOpen(tx, orderId);
        const status = snap.get('status');
        if (status === 'notified') return { ...summary(snap), duplicate: true };
        if (status !== 'available') throw new SalesError('invalid_status', 409);
        tx.update(orderRef(orderId), {
          status: 'notified', notifiedAt: ts(), watchProductIds: [], updatedAt: ts(),
        });
        return { ...summary(snap), status: 'notified' };
      });
    },

    async cancelOrder(uid, orderId, { reason = '' } = {}) {
      return db.runTransaction(async (tx) => {
        const snap = await loadOpen(tx, orderId);
        const status = snap.get('status');
        if (status === 'cancelled') return { ...summary(snap), duplicate: true };
        if (status === 'completed') throw new SalesError('order_closed', 409);
        tx.update(orderRef(orderId), {
          status: 'cancelled', isOpen: false, watchProductIds: [], cancelReason: reason,
          cancelledAt: ts(), cancelledBy: uid, updatedAt: ts(),
        });
        return { ...summary(snap), status: 'cancelled' };
      });
    },

    /**
     * The customer collected the products: create the sale (stock leaves NOW) and close the order, atomically.
     * The sale id is derived from the order id, so even two racing requests can only ever produce one sale.
     * The customer pays the full total in cash (the order keeps the price recorded when it was placed).
     */
    async completeOrder(uid, orderId, { businessDate }) {
      assertBusinessDate(businessDate, now());
      const saleId = `ord_${orderId}`;
      let touched = [];
      const out = await db.runTransaction(async (tx) => {
        touched = [];
        const snap = await loadOpen(tx, orderId); // read 1: the order
        const status = snap.get('status');
        if (status === 'completed') {
          return { id: orderId, number: snap.get('number'), status, saleId: snap.get('saleId'), duplicate: true };
        }
        if (status === 'cancelled') throw new SalesError('order_closed', 409);
        const lines = snap.get('lines') ?? [];
        const total = int(snap.get('total'));
        const note = `${snap.get('number')} - ${snap.get('customerName')}`.slice(0, 200);
        // reads 2..n: everything the sale needs (stock, settings, counter). Throws insufficient_stock etc.
        const plan = await sales.planSale(tx, uid, {
          saleId, clientId: null, businessDate, discount: 0, cashPaid: total, note,
          lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice })),
        });
        // ----- writes -----
        plan.commit();
        tx.update(orderRef(orderId), {
          status: 'completed', isOpen: false, watchProductIds: [],
          saleId, saleNumber: plan.result.number,
          completedAt: ts(), completedBy: uid, updatedAt: ts(),
        });
        touched = lines.map((l) => l.productId);
        return { id: orderId, number: snap.get('number'), status: 'completed', saleId, saleNumber: plan.result.number, duplicate: false };
      });
      if (!out.duplicate) {
        // The sale lowered stock: other orders waiting on the same products may no longer be available.
        checkProducts(touched).catch((err) => logger?.error({ err }, 'post-completion availability check failed'));
      }
      return out;
    },
  };
}
