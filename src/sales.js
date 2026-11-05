import {
  SalesError, MAX_LINES, MAX_OPEN_SALES_PER_PAYMENT, assertBusinessDate, allocateFifo,
  computeTotals, fingerprint, formatNumber,
} from './salesMath.js';

/**
 * Sales, customer payments and voids. Each is ONE Admin-SDK transaction (reads first, no side effects
 * inside: transactions retry), so stock, client balance, counters and daily stats can never drift apart.
 * Firestore rules keep these collections read-only for apps; only this service writes them.
 *
 * Idempotency: the document id is chosen by the app once per user action. Same id + same content returns
 * the stored result (`duplicate: true`); same id + different content is `idempotency_conflict`.
 *
 * `fieldValue` is firebase-admin's FieldValue (injected so tests can run on an in-memory Firestore).
 */
export function createSalesService({ db, fieldValue, now = () => Date.now() }) {
  const settingsRef = db.collection('shop_settings').doc('main');
  const counterRef = (name) => db.collection('counters').doc(name);
  const statsRef = (date) => db.collection('daily_stats').doc(date);
  const productRef = (id) => db.collection('products').doc(id);
  const clientRef = (id) => db.collection('clients').doc(id);
  const inc = (n) => fieldValue.increment(n);
  const ts = () => fieldValue.serverTimestamp();
  const int = (v) => (Number.isSafeInteger(v) ? v : 0);

  const saleSummary = (snap, duplicate) => ({
    id: snap.id,
    number: snap.get('number'),
    total: snap.get('total'),
    remaining: snap.get('remaining'),
    status: snap.get('status'),
    duplicate,
  });

  return {
    /** input: {saleId, clientId?, businessDate, lines:[{productId, qty, unitPrice?}], discount, cashPaid, note} */
    async createSale(uid, input) {
      const { saleId, businessDate, lines, discount, cashPaid, note } = input;
      const clientId = input.clientId ?? null;
      assertBusinessDate(businessDate, now());
      if (lines.length < 1 || lines.length > MAX_LINES) throw new SalesError('invalid_request', 400);
      const ids = lines.map((l) => l.productId);
      if (new Set(ids).size !== ids.length) throw new SalesError('duplicate_product', 400);
      const fp = fingerprint({
        clientId, businessDate, discount, cashPaid, note,
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice ?? null })),
      });
      const saleRef = db.collection('sales').doc(saleId);

      return db.runTransaction(async (tx) => {
        const refs = [saleRef, settingsRef, counterRef('sales'), ...ids.map(productRef)];
        if (clientId) refs.push(clientRef(clientId));
        const snaps = await tx.getAll(...refs); // all reads first
        const [saleSnap, settingsSnap, counterSnap] = snaps;
        const productSnaps = snaps.slice(3, 3 + ids.length);
        const clientSnap = clientId ? snaps[3 + ids.length] : null;

        if (saleSnap.exists) {
          if (saleSnap.get('fingerprint') !== fp) throw new SalesError('idempotency_conflict', 409);
          return saleSummary(saleSnap, true);
        }

        const allowNegative = settingsSnap.exists && settingsSnap.get('allowNegativeStock') === true;
        const prefix = (settingsSnap.exists && settingsSnap.get('invoicePrefix')) || 'TY';

        const priced = lines.map((l, i) => {
          const p = productSnaps[i];
          if (!p.exists) throw new SalesError('product_not_found', 404);
          if (p.get('isActive') === false) throw new SalesError('product_inactive', 409);
          const stock = int(p.get('stockQty'));
          if (!allowNegative && stock < l.qty) throw new SalesError('insufficient_stock', 409);
          return {
            productId: p.id,
            name: p.get('name') ?? '',
            qty: l.qty,
            unitPrice: l.unitPrice ?? int(p.get('sellingPrice')),
            unitCost: int(p.get('avgCost')), // snapshot: profit stays correct when costs change later
            stockBefore: stock,
            categoryId: p.get('categoryId') ?? null,
          };
        });
        const { lineTotals, subtotal, total, credit } = computeTotals(priced, discount, cashPaid);

        if (clientId) {
          if (!clientSnap.exists) throw new SalesError('client_not_found', 404);
          if (clientSnap.get('isArchived') === true) throw new SalesError('client_archived', 409);
        } else if (credit > 0) {
          throw new SalesError('client_required', 400);
        }

        const seq = int(counterSnap.get('value')) + 1;
        const cogs = priced.reduce((a, l) => a + l.qty * l.unitCost, 0);

        // ----- writes -----
        tx.create(saleRef, {
          number: formatNumber(prefix, seq),
          fingerprint: fp,
          clientId,
          clientName: clientId ? clientSnap.get('name') ?? '' : '',
          subtotal, discount, total,
          cashPaid, credit,
          paidTotal: cashPaid, remaining: credit, isOpen: credit > 0,
          cogs, lineCount: priced.length,
          status: 'active',
          note: note ?? '',
          businessDate,
          createdBy: uid,
          createdAt: ts(),
        });
        priced.forEach((l, i) => {
          const n = String(i + 1).padStart(3, '0');
          tx.create(saleRef.collection('sale_items').doc(n), {
            productId: l.productId, productName: l.name, categoryId: l.categoryId,
            qty: l.qty, unitPrice: l.unitPrice, unitCost: l.unitCost, lineTotal: lineTotals[i],
          });
          const mid = `sale_${saleId}_${n}`;
          tx.create(db.collection('stock_movements').doc(mid), {
            productId: l.productId, type: 'sale', reason: 'sale', saleId,
            delta: -l.qty, qtyBefore: l.stockBefore, qtyAfter: l.stockBefore - l.qty,
            avgCostBefore: l.unitCost, avgCostAfter: l.unitCost,
            businessDate, createdBy: uid, createdAt: ts(),
          });
          tx.update(productRef(l.productId), { stockQty: l.stockBefore - l.qty, lastMovementId: mid });
        });
        if (clientId) tx.update(clientRef(clientId), { balance: inc(credit), totalPurchases: inc(total) });
        tx.set(counterRef('sales'), { value: seq });
        tx.set(statsRef(businessDate), {
          businessDate,
          salesCount: inc(1), salesTotal: inc(total), discountTotal: inc(discount),
          cashSales: inc(cashPaid), creditSales: inc(credit), cogs: inc(cogs),
          updatedAt: ts(),
        }, { merge: true });

        return { id: saleId, number: formatNumber(prefix, seq), total, remaining: credit, status: 'active', duplicate: false };
      });
    },

    /**
     * Void = a reversal document (`sale_voids/{saleId}`) + the sale flagged `voided`; nothing is deleted.
     * Stock returns at the cost recorded on the sale; the client's open balance and lifetime total drop.
     * Money already paid on the sale (`paidTotal`) is recorded as `refundDue` (handed back outside the app).
     */
    async voidSale(uid, saleId, { businessDate, reason }) {
      assertBusinessDate(businessDate, now());
      const saleRef = db.collection('sales').doc(saleId);
      const voidRef = db.collection('sale_voids').doc(saleId);

      return db.runTransaction(async (tx) => {
        const [saleSnap, voidSnap] = await tx.getAll(saleRef, voidRef);
        if (!saleSnap.exists) throw new SalesError('sale_not_found', 404);
        if (voidSnap.exists || saleSnap.get('status') === 'voided') {
          return { id: saleId, status: 'voided', duplicate: true };
        }
        const itemsSnap = await tx.get(saleRef.collection('sale_items'));
        const items = itemsSnap.docs.map((d) => ({ n: d.id, ...d.data() }));
        const clientId = saleSnap.get('clientId');
        const refs = items.map((it) => productRef(it.productId));
        if (clientId) refs.push(clientRef(clientId));
        const snaps = refs.length ? await tx.getAll(...refs) : [];
        const productSnaps = snaps.slice(0, items.length);
        const clientSnap = clientId ? snaps[items.length] : null;

        const total = saleSnap.get('total');
        const remaining = saleSnap.get('remaining');
        const paidTotal = saleSnap.get('paidTotal');
        const cogs = saleSnap.get('cogs') ?? 0;

        // ----- writes -----
        items.forEach((it, i) => {
          const p = productSnaps[i];
          if (!p.exists) return; // products are never deleted; defensive only
          const before = int(p.get('stockQty'));
          const mid = `void_${saleId}_${it.n}`;
          tx.create(db.collection('stock_movements').doc(mid), {
            productId: it.productId, type: 'sale_void', reason: 'void', saleId,
            delta: it.qty, qtyBefore: before, qtyAfter: before + it.qty,
            avgCostBefore: int(p.get('avgCost')), avgCostAfter: int(p.get('avgCost')),
            businessDate, createdBy: uid, createdAt: ts(),
          });
          tx.update(productRef(it.productId), { stockQty: before + it.qty, lastMovementId: mid });
        });
        if (clientId && clientSnap.exists) {
          tx.update(clientRef(clientId), { balance: inc(-remaining), totalPurchases: inc(-total) });
        }
        tx.update(saleRef, {
          status: 'voided', isOpen: false, remainingAtVoid: remaining, remaining: 0,
          voidedAt: ts(), voidedBy: uid, voidReason: reason ?? '',
        });
        tx.create(voidRef, {
          saleId, number: saleSnap.get('number'), clientId: clientId ?? null,
          total, paidTotal, remainingCancelled: remaining, refundDue: paidTotal, cogs,
          reason: reason ?? '', businessDate, createdBy: uid, createdAt: ts(),
        });
        tx.set(statsRef(businessDate), {
          businessDate,
          voidsCount: inc(1), voidedTotal: inc(total), voidedCogs: inc(cogs),
          voidedRefunds: inc(paidTotal), voidedCredit: inc(remaining),
          updatedAt: ts(),
        }, { merge: true });

        return { id: saleId, status: 'voided', duplicate: false };
      });
    },

    /** Customer payment settles the client's oldest open sales first (FIFO). */
    async receivePayment(uid, input) {
      const { paymentId, clientId, amount, businessDate, note } = input;
      assertBusinessDate(businessDate, now());
      const fp = fingerprint({ clientId, amount, businessDate, note });
      const payRef = db.collection('customer_payments').doc(paymentId);

      return db.runTransaction(async (tx) => {
        const [paySnap, cSnap, settingsSnap, counterSnap] =
          await tx.getAll(payRef, clientRef(clientId), settingsRef, counterRef('customer_payments'));
        if (paySnap.exists) {
          if (paySnap.get('fingerprint') !== fp) throw new SalesError('idempotency_conflict', 409);
          return { id: paymentId, number: paySnap.get('number'), amount: paySnap.get('amount'), duplicate: true };
        }
        if (!cSnap.exists) throw new SalesError('client_not_found', 404);
        const balance = int(cSnap.get('balance'));
        if (balance <= 0) throw new SalesError('nothing_due', 409);
        if (amount > balance) throw new SalesError('overpayment', 409);

        const openSnap = await tx.get(
          db.collection('sales')
            .where('clientId', '==', clientId)
            .where('isOpen', '==', true)
            .orderBy('createdAt', 'asc')
            .limit(MAX_OPEN_SALES_PER_PAYMENT),
        );
        const open = openSnap.docs.map((d) => ({ id: d.id, remaining: d.get('remaining'), paidTotal: d.get('paidTotal') }));
        const { allocations, leftover } = allocateFifo(open, amount);
        if (leftover > 0) {
          // Either more open sales than one payment may touch, or the balance disagrees with the sales.
          throw new SalesError(open.length >= MAX_OPEN_SALES_PER_PAYMENT ? 'payment_too_large' : 'balance_mismatch', 409);
        }
        const prefix = (settingsSnap.exists && settingsSnap.get('invoicePrefix')) || 'TY';
        const seq = int(counterSnap.get('value')) + 1;
        const number = formatNumber(`${prefix}-R`, seq);

        // ----- writes -----
        const byId = new Map(open.map((s) => [s.id, s]));
        for (const a of allocations) {
          const s = byId.get(a.saleId);
          const remaining = s.remaining - a.amount;
          tx.update(db.collection('sales').doc(a.saleId), {
            paidTotal: s.paidTotal + a.amount, remaining, isOpen: remaining > 0,
          });
        }
        tx.create(payRef, {
          number, fingerprint: fp, clientId, clientName: cSnap.get('name') ?? '',
          amount, allocations, note: note ?? '', businessDate, createdBy: uid, createdAt: ts(),
        });
        tx.update(clientRef(clientId), { balance: inc(-amount) });
        tx.set(counterRef('customer_payments'), { value: seq });
        tx.set(statsRef(businessDate), {
          businessDate, paymentsCount: inc(1), paymentsReceived: inc(amount), updatedAt: ts(),
        }, { merge: true });

        return { id: paymentId, number, amount, duplicate: false };
      });
    },
  };
}
