import { describe, it, expect, beforeEach } from 'vitest';
import { createPurchasesService } from '../src/purchases.js';
import { createSalesService } from '../src/sales.js';
import { createFakeDb, fieldValue } from './helpers/fakeFirestore.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const DATE = '2026-11-03';
const UID = 'u1';

let db;
let svc;
const code = async (p) => { try { await p; } catch (e) { return e.code ?? `other:${e.message}`; } return null; };

beforeEach(() => {
  db = createFakeDb();
  svc = createPurchasesService({ db, fieldValue, now: () => NOW });
  db.seed('shop_settings/main', { allowNegativeStock: false, invoicePrefix: 'TY' });
  db.seed('products/p1', { name: 'رب 250غ', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 10, isActive: true });
  db.seed('products/p2', { name: 'دهان 250غ', categoryId: 'c1', sellingPrice: 18000, avgCost: 0, stockQty: 0, isActive: true });
  db.seed('products/off', { name: 'قديم', categoryId: 'c1', sellingPrice: 1000, avgCost: 0, stockQty: 5, isActive: false });
  db.seed('suppliers/s1', { name: 'مورد', balance: 0, totalPurchases: 0, isArchived: false });
  db.seed('suppliers/old', { name: 'مؤرشف', balance: 0, totalPurchases: 0, isArchived: true });
});

const purchase = (over = {}) => ({
  purchaseId: 'buy-0001-aaaa', supplierId: 's1', invoiceRef: 'F-77', businessDate: DATE,
  lines: [{ productId: 'p1', qty: 10, unitCost: 5000 }, { productId: 'p2', qty: 5, unitCost: 2000 }],
  discount: 0, extraCosts: 0, cashPaid: 20000, note: '', ...over,
});

describe('createPurchase', () => {
  it('totals, items, movements, average cost, supplier balance, stats, counter', async () => {
    const r = await svc.createPurchase(UID, purchase());
    expect(r).toMatchObject({ id: 'buy-0001-aaaa', number: 'TY-P-000001', total: 60000, remaining: 40000, duplicate: false });
    expect(db.get('purchases/buy-0001-aaaa')).toMatchObject({
      subtotal: 60000, total: 60000, cashPaid: 20000, credit: 40000, isOpen: true, status: 'active', lineCount: 2, supplierName: 'مورد', invoiceRef: 'F-77',
    });
    expect(db.get('purchases/buy-0001-aaaa/purchase_items/001')).toMatchObject({ productId: 'p1', qty: 10, unitCost: 5000, lineTotal: 50000, landedTotal: 50000, landedUnitCost: 5000 });
    // p1: 10 units @4000 + 10 @5000 -> 4500
    expect(db.get('products/p1')).toMatchObject({ stockQty: 20, avgCost: 4500, lastMovementId: 'purchase_buy-0001-aaaa_001' });
    // p2: empty stock -> the unit cost
    expect(db.get('products/p2')).toMatchObject({ stockQty: 5, avgCost: 2000 });
    expect(db.get('stock_movements/purchase_buy-0001-aaaa_001')).toMatchObject({
      type: 'purchase', delta: 10, qtyBefore: 10, qtyAfter: 20, avgCostBefore: 4000, avgCostAfter: 4500, purchaseId: 'buy-0001-aaaa',
    });
    expect(db.get('suppliers/s1')).toMatchObject({ balance: 40000, totalPurchases: 60000 });
    expect(db.get('counters/purchases')).toEqual({ value: 1 });
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ purchasesCount: 1, purchasesTotal: 60000, purchasesCash: 20000, purchasesCredit: 40000 });
  });

  it('discount and extra costs flow into the landed cost and the average', async () => {
    const r = await svc.createPurchase(UID, purchase({ extraCosts: 6000, discount: 0, cashPaid: 0, lines: [{ productId: 'p2', qty: 5, unitCost: 2000 }] }));
    expect(r.total).toBe(16000);
    expect(db.get('purchases/buy-0001-aaaa')).toMatchObject({ subtotal: 10000, extraCosts: 6000, total: 16000 });
    expect(db.get('purchases/buy-0001-aaaa/purchase_items/001')).toMatchObject({ lineTotal: 10000, landedTotal: 16000, landedUnitCost: 3200 });
    expect(db.get('products/p2').avgCost).toBe(3200);
    expect(db.get('suppliers/s1').balance).toBe(16000);
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ purchasesExtra: 6000, purchasesDiscount: 0 });
  });

  it('validates supplier, products, discount and payment', async () => {
    expect(await code(svc.createPurchase(UID, purchase({ supplierId: 'nope' })))).toBe('supplier_not_found');
    expect(await code(svc.createPurchase(UID, purchase({ supplierId: 'old' })))).toBe('supplier_archived');
    expect(await code(svc.createPurchase(UID, purchase({ lines: [{ productId: 'off', qty: 1, unitCost: 1 }] })))).toBe('product_inactive');
    expect(await code(svc.createPurchase(UID, purchase({ lines: [{ productId: 'zzz', qty: 1, unitCost: 1 }] })))).toBe('product_not_found');
    expect(await code(svc.createPurchase(UID, purchase({ lines: [{ productId: 'p1', qty: 1, unitCost: 1 }, { productId: 'p1', qty: 1, unitCost: 1 }] })))).toBe('duplicate_product');
    expect(await code(svc.createPurchase(UID, purchase({ discount: 60001 })))).toBe('discount_too_high');
    expect(await code(svc.createPurchase(UID, purchase({ cashPaid: 60001 })))).toBe('invalid_payment');
    expect(await code(svc.createPurchase(UID, purchase({ businessDate: '2026-01-01' })))).toBe('invalid_business_date');
    expect(db.get('counters/purchases')).toBeUndefined(); // nothing committed
  });

  it('is idempotent and detects reuse of an id with other content', async () => {
    await svc.createPurchase(UID, purchase());
    const again = await svc.createPurchase(UID, purchase());
    expect(again.duplicate).toBe(true);
    expect(db.get('products/p1').stockQty).toBe(20); // not received twice
    expect(db.get('counters/purchases')).toEqual({ value: 1 });
    expect(await code(svc.createPurchase(UID, purchase({ cashPaid: 1 })))).toBe('idempotency_conflict');
  });
});

describe('paySupplier (FIFO)', () => {
  beforeEach(async () => {
    await svc.createPurchase(UID, purchase({ purchaseId: 'buy-0001-aaaa', cashPaid: 0, lines: [{ productId: 'p1', qty: 1, unitCost: 10000 }] }));
    await svc.createPurchase(UID, purchase({ purchaseId: 'buy-0002-bbbb', cashPaid: 0, lines: [{ productId: 'p1', qty: 1, unitCost: 20000 }] }));
  });
  const pay = (over = {}) => ({ paymentId: 'spay-0001-aaaa', supplierId: 's1', amount: 15000, businessDate: DATE, note: '', ...over });

  it('settles the oldest purchase first and lowers the supplier balance', async () => {
    const r = await svc.paySupplier(UID, pay());
    expect(r).toMatchObject({ number: 'TY-S-000001', amount: 15000, duplicate: false });
    expect(db.get('purchases/buy-0001-aaaa')).toMatchObject({ paidTotal: 10000, remaining: 0, isOpen: false });
    expect(db.get('purchases/buy-0002-bbbb')).toMatchObject({ paidTotal: 5000, remaining: 15000, isOpen: true });
    expect(db.get('supplier_payments/spay-0001-aaaa').allocations).toEqual([{ purchaseId: 'buy-0001-aaaa', amount: 10000 }, { purchaseId: 'buy-0002-bbbb', amount: 5000 }]);
    expect(db.get('suppliers/s1').balance).toBe(15000);
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ supplierPaymentsCount: 1, supplierPaymentsPaid: 15000 });
  });
  it('is idempotent; rejects overpayment and nothing due', async () => {
    await svc.paySupplier(UID, pay());
    expect((await svc.paySupplier(UID, pay())).duplicate).toBe(true);
    expect(db.get('suppliers/s1').balance).toBe(15000);
    expect(await code(svc.paySupplier(UID, pay({ paymentId: 'spay-0002-bbbb', amount: 15001 })))).toBe('overpayment');
    await svc.paySupplier(UID, pay({ paymentId: 'spay-0003-cccc', amount: 15000 }));
    expect(await code(svc.paySupplier(UID, pay({ paymentId: 'spay-0004-dddd', amount: 1 })))).toBe('nothing_due');
    expect(await code(svc.paySupplier(UID, pay({ supplierId: 'nope', paymentId: 'spay-0005-eeee' })))).toBe('supplier_not_found');
  });
});

describe('voidPurchase', () => {
  it('restores stock and average cost, cancels the debt, records the reversal', async () => {
    await svc.createPurchase(UID, purchase({ lines: [{ productId: 'p1', qty: 10, unitCost: 5000 }], cashPaid: 20000 }));
    expect(db.get('products/p1')).toMatchObject({ stockQty: 20, avgCost: 4500 });
    const r = await svc.voidPurchase(UID, 'buy-0001-aaaa', { businessDate: DATE, reason: 'خطأ' });
    expect(r).toMatchObject({ status: 'voided', duplicate: false });
    expect(db.get('products/p1')).toMatchObject({ stockQty: 10, avgCost: 4000, lastMovementId: 'pvoid_buy-0001-aaaa_001' });
    expect(db.get('stock_movements/pvoid_buy-0001-aaaa_001')).toMatchObject({ type: 'purchase_void', delta: -10, qtyAfter: 10 });
    expect(db.get('suppliers/s1')).toMatchObject({ balance: 0, totalPurchases: 0 });
    expect(db.get('purchases/buy-0001-aaaa')).toMatchObject({ status: 'voided', isOpen: false, remaining: 0, remainingAtVoid: 30000 });
    expect(db.get('purchase_voids/buy-0001-aaaa')).toMatchObject({ total: 50000, paidTotal: 20000, refundDue: 20000, remainingCancelled: 30000 });
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ purchaseVoidsCount: 1, purchaseVoidedTotal: 50000, purchaseVoidedRefunds: 20000, purchaseVoidedCredit: 30000 });
    // idempotent
    expect((await svc.voidPurchase(UID, 'buy-0001-aaaa', { businessDate: DATE })).duplicate).toBe(true);
    expect(db.get('products/p1').stockQty).toBe(10);
  });

  it('is blocked once part of the received stock was sold; allowed when enough is still on hand', async () => {
    const sales = createSalesService({ db, fieldValue, now: () => NOW });
    await svc.createPurchase(UID, purchase({ lines: [{ productId: 'p2', qty: 5, unitCost: 2000 }], cashPaid: 10000 }));
    await sales.createSale(UID, { saleId: 'sale-0001-aaaa', clientId: null, businessDate: DATE, lines: [{ productId: 'p2', qty: 1 }], discount: 0, cashPaid: 18000, note: '' });
    expect(await code(svc.voidPurchase(UID, 'buy-0001-aaaa', { businessDate: DATE }))).toBe('stock_already_sold');
    expect(db.get('products/p2').stockQty).toBe(4); // untouched
    expect(db.get('purchases/buy-0001-aaaa').status).toBe('active');
    // p1 had 10 before this purchase: selling a few of those does not block a later purchase's void
    await svc.createPurchase(UID, purchase({ purchaseId: 'buy-0002-bbbb', lines: [{ productId: 'p1', qty: 2, unitCost: 4000 }], cashPaid: 8000 }));
    await sales.createSale(UID, { saleId: 'sale-0002-bbbb', clientId: null, businessDate: DATE, lines: [{ productId: 'p1', qty: 3 }], discount: 0, cashPaid: 19500, note: '' });
    expect(db.get('products/p1').stockQty).toBe(9);
    await svc.voidPurchase(UID, 'buy-0002-bbbb', { businessDate: DATE });
    expect(db.get('products/p1').stockQty).toBe(7);
  });

  it('after a supplier payment the void records the refund and only the still-open part leaves the balance', async () => {
    await svc.createPurchase(UID, purchase({ lines: [{ productId: 'p1', qty: 2, unitCost: 5000 }], cashPaid: 0 }));
    await svc.paySupplier(UID, { paymentId: 'spay-0001-aaaa', supplierId: 's1', amount: 4000, businessDate: DATE, note: '' });
    await svc.voidPurchase(UID, 'buy-0001-aaaa', { businessDate: DATE });
    expect(db.get('suppliers/s1')).toMatchObject({ balance: 0, totalPurchases: 0 });
    expect(db.get('purchase_voids/buy-0001-aaaa')).toMatchObject({ refundDue: 4000, remainingCancelled: 6000 });
    expect(await code(svc.voidPurchase(UID, 'nope-0001-aaaa', { businessDate: DATE }))).toBe('purchase_not_found');
  });
});
