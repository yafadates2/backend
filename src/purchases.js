import { SalesError, MAX_LINES, MAX_OPEN_SALES_PER_PAYMENT, assertBusinessDate, allocateFifo, fingerprint, formatNumber } from './salesMath.js';
import { computePurchaseTotals, avgAfterReceive, avgAfterRemoval } from './purchasesMath.js';

/**
 * Purchases, supplier payments and purchase voids: the supplier-side mirror of sales.js.
 * Each operation is ONE Admin-SDK transaction (reads first, no side effects inside), so stock, weighted-average
 * cost, supplier balance, counters and daily stats cannot drift apart. Rules keep these collections read-only for apps.
 *
 * Idempotency: the document id is chosen by the app once per action. Same id + same content = stored result
 * (`duplicate: true`); same id + other content = `idempotency_conflict`.
 */
export function createPurchasesService({ db, fieldValue, now = () => Date.now() }) {
  const settingsRef = db.collection('shop_settings').doc('main');
  const counterRef = (name) => db.collection('counters').doc(name);
  const statsRef = (date) => db.collection('daily_stats').doc(date);
  const productRef = (id) => db.collection('products').doc(id);
  const supplierRef = (id) => db.collection('suppliers').doc(id);
  const movementRef = (id) => db.collection('stock_movements').doc(id);
  const inc = (n) => fieldValue.increment(n);
  const ts = () => fieldValue.serverTimestamp();
  const int = (v) => (Number.isSafeInteger(v) ? v : 0);
  const nn = (i) => String(i + 1).padStart(3, '0');

  return {
    /** input: {purchaseId, supplierId, invoiceRef, businessDate, lines:[{productId, qty, unitCost}], discount, extraCosts, cashPaid, note} */
    async createPurchase(uid, input) {
      const { purchaseId, supplierId, businessDate, lines, discount, extraCosts, cashPaid } = input;
      const invoiceRef = input.invoiceRef ?? '';
      const note = input.note ?? '';
      assertBusinessDate(businessDate, now());
      if (lines.length < 1 || lines.length > MAX_LINES) throw new SalesError('invalid_request', 400);
      const ids = lines.map((l) => l.productId);
      if (new Set(ids).size !== ids.length) throw new SalesError('duplicate_product', 400);
      const fp = fingerprint({
        supplierId, invoiceRef, businessDate, discount, extraCosts, cashPaid, note,
        lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.unitCost })),
      });
      const purchaseRef = db.collection('purchases').doc(purchaseId);

      return db.runTransaction(async (tx) => {
        const snaps = await tx.getAll(purchaseRef, settingsRef, counterRef('purchases'), supplierRef(supplierId), ...ids.map(productRef));
        const [purchaseSnap, settingsSnap, counterSnap, supplierSnap] = snaps;
        const productSnaps = snaps.slice(4);

        if (purchaseSnap.exists) {
          if (purchaseSnap.get('fingerprint') !== fp) throw new SalesError('idempotency_conflict', 409);
          return {
            id: purchaseSnap.id, number: purchaseSnap.get('number'), total: purchaseSnap.get('total'),
            remaining: purchaseSnap.get('remaining'), status: purchaseSnap.get('status'), duplicate: true,
          };
        }
        if (!supplierSnap.exists) throw new SalesError('supplier_not_found', 404);
        if (supplierSnap.get('isArchived') === true) throw new SalesError('supplier_archived', 409);

        const prefix = (settingsSnap.exists && settingsSnap.get('invoicePrefix')) || 'TY';
        const priced = lines.map((l, i) => {
          const p = productSnaps[i];
          if (!p.exists) throw new SalesError('product_not_found', 404);
          if (p.get('isActive') === false) throw new SalesError('product_inactive', 409);
          return {
            productId: p.id, name: p.get('name') ?? '', categoryId: p.get('categoryId') ?? null,
            qty: l.qty, unitCost: l.unitCost,
            stockBefore: int(p.get('stockQty')), avgBefore: int(p.get('avgCost')),
          };
        });
        const { lineTotals, subtotal, total, credit, landedTotals, landedUnitCosts } =
          computePurchaseTotals(priced, discount, extraCosts, cashPaid);

        const seq = int(counterSnap.get('value')) + 1;
        const number = formatNumber(`${prefix}-P`, seq);

        // ----- writes -----
        tx.create(purchaseRef, {
          number, fingerprint: fp, supplierId, supplierName: supplierSnap.get('name') ?? '', invoiceRef,
          subtotal, discount, extraCosts, total, cashPaid, credit,
          paidTotal: cashPaid, remaining: credit, isOpen: credit > 0,
          lineCount: priced.length, status: 'active', note, businessDate,
          createdBy: uid, createdAt: ts(),
        });
        priced.forEach((l, i) => {
          const n = nn(i);
          const avgAfter = avgAfterReceive(l.stockBefore, l.avgBefore, l.qty, landedTotals[i]);
          tx.create(purchaseRef.collection('purchase_items').doc(n), {
            productId: l.productId, productName: l.name, categoryId: l.categoryId,
            qty: l.qty, unitCost: l.unitCost, lineTotal: lineTotals[i],
            landedTotal: landedTotals[i], landedUnitCost: landedUnitCosts[i],
          });
          const mid = `purchase_${purchaseId}_${n}`;
          tx.create(movementRef(mid), {
            productId: l.productId, type: 'purchase', reason: 'purchase', purchaseId,
            delta: l.qty, qtyBefore: l.stockBefore, qtyAfter: l.stockBefore + l.qty,
            unitCost: landedUnitCosts[i], avgCostBefore: l.avgBefore, avgCostAfter: avgAfter,
            businessDate, createdBy: uid, createdAt: ts(),
          });
          tx.update(productRef(l.productId), { stockQty: l.stockBefore + l.qty, avgCost: avgAfter, lastMovementId: mid });
        });
        tx.update(supplierRef(supplierId), { balance: inc(credit), totalPurchases: inc(total) });
        tx.set(counterRef('purchases'), { value: seq });
        tx.set(statsRef(businessDate), {
          businessDate,
          purchasesCount: inc(1), purchasesTotal: inc(total), purchasesDiscount: inc(discount),
          purchasesExtra: inc(extraCosts), purchasesCash: inc(cashPaid), purchasesCredit: inc(credit),
          updatedAt: ts(),
        }, { merge: true });

        return { id: purchaseId, number, total, remaining: credit, status: 'active', duplicate: false };
      });
    },

    /**
     * Void = reversal document `purchase_voids/{purchaseId}` + the purchase flagged `voided`; nothing is deleted.
     * Allowed only while the received stock is still on hand (stockQty >= received qty for every line);
     * otherwise `stock_already_sold`. Each product's average cost is recomputed without the purchase's landed value.
     * Money already paid (`paidTotal`) is recorded as `refundDue` (the supplier gives it back outside the app).
     */
    async voidPurchase(uid, purchaseId, { businessDate, reason }) {
      assertBusinessDate(businessDate, now());
      const purchaseRef = db.collection('purchases').doc(purchaseId);
      const voidRef = db.collection('purchase_voids').doc(purchaseId);

      return db.runTransaction(async (tx) => {
        const [purchaseSnap, voidSnap] = await tx.getAll(purchaseRef, voidRef);
        if (!purchaseSnap.exists) throw new SalesError('purchase_not_found', 404);
        if (voidSnap.exists || purchaseSnap.get('status') === 'voided') {
          return { id: purchaseId, status: 'voided', duplicate: true };
        }
        const itemsSnap = await tx.get(purchaseRef.collection('purchase_items'));
        const items = itemsSnap.docs.map((d) => ({ n: d.id, ...d.data() }));
        const supplierId = purchaseSnap.get('supplierId');
        const refs = [
          ...items.map((it) => productRef(it.productId)),
          ...items.map((it) => movementRef(`purchase_${purchaseId}_${it.n}`)),
          supplierRef(supplierId),
        ];
        const snaps = await tx.getAll(...refs);
        const productSnaps = snaps.slice(0, items.length);
        const movementSnaps = snaps.slice(items.length, 2 * items.length);
        const supplierSnap = snaps[2 * items.length];

        const plan = items.map((it, i) => {
          const p = productSnaps[i];
          if (!p.exists) throw new SalesError('stock_already_sold', 409);
          const stock = int(p.get('stockQty'));
          if (stock < it.qty) throw new SalesError('stock_already_sold', 409);
          const avg = int(p.get('avgCost'));
          const fallback = int(movementSnaps[i].get('avgCostBefore'));
          return { it, stock, avg, avgAfter: avgAfterRemoval(stock, avg, it.qty, it.landedTotal, fallback) };
        });

        const total = purchaseSnap.get('total');
        const remaining = purchaseSnap.get('remaining');
        const paidTotal = purchaseSnap.get('paidTotal');

        // ----- writes -----
        plan.forEach(({ it, stock, avg, avgAfter }) => {
          const mid = `pvoid_${purchaseId}_${it.n}`;
          tx.create(movementRef(mid), {
            productId: it.productId, type: 'purchase_void', reason: 'void', purchaseId,
            delta: -it.qty, qtyBefore: stock, qtyAfter: stock - it.qty,
            avgCostBefore: avg, avgCostAfter: avgAfter,
            businessDate, createdBy: uid, createdAt: ts(),
          });
          tx.update(productRef(it.productId), { stockQty: stock - it.qty, avgCost: avgAfter, lastMovementId: mid });
        });
        if (supplierSnap.exists) tx.update(supplierRef(supplierId), { balance: inc(-remaining), totalPurchases: inc(-total) });
        tx.update(purchaseRef, {
          status: 'voided', isOpen: false, remainingAtVoid: remaining, remaining: 0,
          voidedAt: ts(), voidedBy: uid, voidReason: reason ?? '',
        });
        tx.create(voidRef, {
          purchaseId, number: purchaseSnap.get('number'), supplierId,
          total, paidTotal, remainingCancelled: remaining, refundDue: paidTotal,
          reason: reason ?? '', businessDate, createdBy: uid, createdAt: ts(),
        });
        tx.set(statsRef(businessDate), {
          businessDate,
          purchaseVoidsCount: inc(1), purchaseVoidedTotal: inc(total),
          purchaseVoidedRefunds: inc(paidTotal), purchaseVoidedCredit: inc(remaining),
          updatedAt: ts(),
        }, { merge: true });

        return { id: purchaseId, status: 'voided', duplicate: false };
      });
    },

    /** The shop pays a supplier: settles the oldest open purchases first (FIFO). */
    async paySupplier(uid, input) {
      const { paymentId, supplierId, amount, businessDate, note } = input;
      assertBusinessDate(businessDate, now());
      const fp = fingerprint({ supplierId, amount, businessDate, note });
      const payRef = db.collection('supplier_payments').doc(paymentId);

      return db.runTransaction(async (tx) => {
        const [paySnap, sSnap, settingsSnap, counterSnap] =
          await tx.getAll(payRef, supplierRef(supplierId), settingsRef, counterRef('supplier_payments'));
        if (paySnap.exists) {
          if (paySnap.get('fingerprint') !== fp) throw new SalesError('idempotency_conflict', 409);
          return { id: paymentId, number: paySnap.get('number'), amount: paySnap.get('amount'), duplicate: true };
        }
        if (!sSnap.exists) throw new SalesError('supplier_not_found', 404);
        const balance = int(sSnap.get('balance'));
        if (balance <= 0) throw new SalesError('nothing_due', 409);
        if (amount > balance) throw new SalesError('overpayment', 409);

        const openSnap = await tx.get(
          db.collection('purchases')
            .where('supplierId', '==', supplierId)
            .where('isOpen', '==', true)
            .orderBy('createdAt', 'asc')
            .limit(MAX_OPEN_SALES_PER_PAYMENT),
        );
        const open = openSnap.docs.map((d) => ({ id: d.id, remaining: d.get('remaining'), paidTotal: d.get('paidTotal') }));
        const { allocations, leftover } = allocateFifo(open.map((p) => ({ id: p.id, remaining: p.remaining })), amount);
        if (leftover > 0) {
          throw new SalesError(open.length >= MAX_OPEN_SALES_PER_PAYMENT ? 'payment_too_large' : 'balance_mismatch', 409);
        }
        const prefix = (settingsSnap.exists && settingsSnap.get('invoicePrefix')) || 'TY';
        const seq = int(counterSnap.get('value')) + 1;
        const number = formatNumber(`${prefix}-S`, seq);

        // ----- writes -----
        const byId = new Map(open.map((p) => [p.id, p]));
        for (const a of allocations) {
          const p = byId.get(a.saleId);
          const remaining = p.remaining - a.amount;
          tx.update(db.collection('purchases').doc(a.saleId), { paidTotal: p.paidTotal + a.amount, remaining, isOpen: remaining > 0 });
        }
        tx.create(payRef, {
          number, fingerprint: fp, supplierId, supplierName: sSnap.get('name') ?? '', amount,
          allocations: allocations.map((a) => ({ purchaseId: a.saleId, amount: a.amount })),
          note: note ?? '', businessDate, createdBy: uid, createdAt: ts(),
        });
        tx.update(supplierRef(supplierId), { balance: inc(-amount) });
        tx.set(counterRef('supplier_payments'), { value: seq });
        tx.set(statsRef(businessDate), {
          businessDate, supplierPaymentsCount: inc(1), supplierPaymentsPaid: inc(amount), updatedAt: ts(),
        }, { merge: true });

        return { id: paymentId, number, amount, duplicate: false };
      });
    },
  };
}
