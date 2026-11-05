import { describe, it, expect, beforeEach } from 'vitest';
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
  svc = createSalesService({ db, fieldValue, now: () => NOW });
  db.seed('shop_settings/main', { allowNegativeStock: false, invoicePrefix: 'TY' });
  db.seed('products/p1', { name: 'رب 250غ', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 10, isActive: true });
  db.seed('products/p2', { name: 'دهان 250غ', categoryId: 'c1', sellingPrice: 18000, avgCost: 12000, stockQty: 3, isActive: true });
  db.seed('products/off', { name: 'قديم', categoryId: 'c1', sellingPrice: 1000, avgCost: 0, stockQty: 5, isActive: false });
  db.seed('clients/k1', { name: 'سالم', balance: 0, totalPurchases: 0, isArchived: false });
  db.seed('clients/old', { name: 'مؤرشف', balance: 0, totalPurchases: 0, isArchived: true });
});

const sale = (over = {}) => ({
  saleId: 'sale-0001-aaaa', clientId: null, businessDate: DATE,
  lines: [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1, unitPrice: 17000 }],
  discount: 0, cashPaid: 30000, note: '', ...over,
});

describe('createSale', () => {
  it('cash sale: totals, snapshot prices/costs, stock, movements, stats, counter', async () => {
    const r = await svc.createSale(UID, sale());
    expect(r).toMatchObject({ id: 'sale-0001-aaaa', number: 'TY-000001', total: 30000, remaining: 0, duplicate: false });
    const s = db.get('sales/sale-0001-aaaa');
    expect(s).toMatchObject({ subtotal: 30000, total: 30000, cashPaid: 30000, credit: 0, isOpen: false, status: 'active', cogs: 20000, lineCount: 2 });
    expect(db.get('sales/sale-0001-aaaa/sale_items/001')).toMatchObject({ productId: 'p1', qty: 2, unitPrice: 6500, unitCost: 4000, lineTotal: 13000 });
    expect(db.get('sales/sale-0001-aaaa/sale_items/002')).toMatchObject({ unitPrice: 17000, lineTotal: 17000, unitCost: 12000 });
    expect(db.get('products/p1')).toMatchObject({ stockQty: 8, lastMovementId: 'sale_sale-0001-aaaa_001' });
    expect(db.get('products/p2').stockQty).toBe(2);
    expect(db.get('stock_movements/sale_sale-0001-aaaa_001')).toMatchObject({ type: 'sale', delta: -2, qtyBefore: 10, qtyAfter: 8, saleId: 'sale-0001-aaaa' });
    expect(db.get('counters/sales')).toEqual({ value: 1 });
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ salesCount: 1, salesTotal: 30000, cashSales: 30000, creditSales: 0, cogs: 20000 });
  });

  it('credit sale needs an existing client and moves the client balance', async () => {
    expect(await code(svc.createSale(UID, sale({ cashPaid: 10000 })))).toBe('client_required');
    expect(await code(svc.createSale(UID, sale({ cashPaid: 10000, clientId: 'nope' })))).toBe('client_not_found');
    expect(await code(svc.createSale(UID, sale({ cashPaid: 10000, clientId: 'old' })))).toBe('client_archived');
    const r = await svc.createSale(UID, sale({ cashPaid: 10000, clientId: 'k1', discount: 2000 }));
    expect(r).toMatchObject({ total: 28000, remaining: 18000 });
    expect(db.get('clients/k1')).toMatchObject({ balance: 18000, totalPurchases: 28000 });
    expect(db.get('sales/sale-0001-aaaa')).toMatchObject({ isOpen: true, remaining: 18000, clientName: 'سالم' });
  });

  it('is idempotent and detects reuse of an id with other content', async () => {
    await svc.createSale(UID, sale());
    const again = await svc.createSale(UID, sale());
    expect(again.duplicate).toBe(true);
    expect(db.get('products/p1').stockQty).toBe(8); // not deducted twice
    expect(db.get('counters/sales')).toEqual({ value: 1 });
    expect(await code(svc.createSale(UID, sale({ cashPaid: 29000, clientId: 'k1' })))).toBe('idempotency_conflict');
  });

  it('blocks insufficient stock unless the shop allows negative stock; a failed sale writes nothing', async () => {
    const big = sale({ lines: [{ productId: 'p1', qty: 1 }, { productId: 'p2', qty: 4 }], cashPaid: 0, clientId: 'k1' });
    expect(await code(svc.createSale(UID, big))).toBe('insufficient_stock');
    expect(db.get('products/p1').stockQty).toBe(10);
    expect(db.get('sales/sale-0001-aaaa')).toBeUndefined();
    db.seed('shop_settings/main', { allowNegativeStock: true, invoicePrefix: 'TY' });
    await svc.createSale(UID, big);
    expect(db.get('products/p2').stockQty).toBe(-1);
  });

  it('rejects inactive/missing products, duplicates, bad money and bad dates', async () => {
    expect(await code(svc.createSale(UID, sale({ lines: [{ productId: 'off', qty: 1 }], cashPaid: 1000 })))).toBe('product_inactive');
    expect(await code(svc.createSale(UID, sale({ lines: [{ productId: 'zz', qty: 1 }] })))).toBe('product_not_found');
    expect(await code(svc.createSale(UID, sale({ lines: [{ productId: 'p1', qty: 1 }, { productId: 'p1', qty: 1 }] })))).toBe('duplicate_product');
    expect(await code(svc.createSale(UID, sale({ discount: 99999 })))).toBe('discount_too_high');
    expect(await code(svc.createSale(UID, sale({ cashPaid: 99999 })))).toBe('invalid_payment');
    expect(await code(svc.createSale(UID, sale({ businessDate: '2026-01-01' })))).toBe('invalid_business_date');
  });

  it('numbers sales consecutively with the shop prefix', async () => {
    db.seed('shop_settings/main', { allowNegativeStock: false, invoicePrefix: 'ABC' });
    await svc.createSale(UID, sale({ saleId: 'sale-0001-aaaa' }));
    const r = await svc.createSale(UID, sale({ saleId: 'sale-0002-bbbb' }));
    expect(r.number).toBe('ABC-000002');
  });
});

describe('receivePayment (FIFO)', () => {
  const credit = (id, price) => sale({ saleId: id, clientId: 'k1', cashPaid: 0, lines: [{ productId: 'p1', qty: 1, unitPrice: price }] });
  const pay = (over = {}) => ({ paymentId: 'pay-0001-aaaa', clientId: 'k1', amount: 6000, businessDate: DATE, note: '', ...over });

  beforeEach(async () => {
    await svc.createSale(UID, credit('sale-0001-aaaa', 5000)); // oldest
    await svc.createSale(UID, credit('sale-0002-bbbb', 3000));
    await svc.createSale(UID, credit('sale-0003-cccc', 9000));
  });

  it('settles the oldest sales first and lowers the client balance', async () => {
    expect(db.get('clients/k1').balance).toBe(17000);
    const r = await svc.receivePayment(UID, pay());
    expect(r).toMatchObject({ number: 'TY-R-000001', amount: 6000, duplicate: false });
    expect(db.get('sales/sale-0001-aaaa')).toMatchObject({ remaining: 0, paidTotal: 5000, isOpen: false });
    expect(db.get('sales/sale-0002-bbbb')).toMatchObject({ remaining: 2000, paidTotal: 1000, isOpen: true });
    expect(db.get('sales/sale-0003-cccc').remaining).toBe(9000);
    expect(db.get('clients/k1').balance).toBe(11000);
    expect(db.get('customer_payments/pay-0001-aaaa').allocations).toEqual([
      { saleId: 'sale-0001-aaaa', amount: 5000 }, { saleId: 'sale-0002-bbbb', amount: 1000 }]);
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ paymentsReceived: 6000, paymentsCount: 1 });
  });

  it('is idempotent and conflict-safe', async () => {
    await svc.receivePayment(UID, pay());
    expect((await svc.receivePayment(UID, pay())).duplicate).toBe(true);
    expect(db.get('clients/k1').balance).toBe(11000);
    expect(await code(svc.receivePayment(UID, pay({ amount: 7000 })))).toBe('idempotency_conflict');
  });

  it('refuses overpayment and payments when nothing is due', async () => {
    expect(await code(svc.receivePayment(UID, pay({ amount: 17001 })))).toBe('overpayment');
    await svc.receivePayment(UID, pay({ amount: 17000 }));
    expect(db.get('clients/k1').balance).toBe(0);
    expect(await code(svc.receivePayment(UID, pay({ paymentId: 'pay-0002-bbbb', amount: 1 })))).toBe('nothing_due');
  });

  it('flags a balance that disagrees with the open sales instead of guessing', async () => {
    db.seed('clients/k1', { name: 'سالم', balance: 99000, totalPurchases: 0, isArchived: false });
    expect(await code(svc.receivePayment(UID, pay({ amount: 20000 })))).toBe('balance_mismatch');
  });
});

describe('voidSale', () => {
  it('returns stock, reverses the client balance, keeps the sale and writes a reversal document', async () => {
    await svc.createSale(UID, sale({ clientId: 'k1', cashPaid: 10000 })); // total 30000, credit 20000
    const r = await svc.voidSale(UID, 'sale-0001-aaaa', { businessDate: DATE, reason: 'خطأ' });
    expect(r).toMatchObject({ status: 'voided', duplicate: false });
    expect(db.get('products/p1').stockQty).toBe(10);
    expect(db.get('products/p2').stockQty).toBe(3);
    expect(db.get('stock_movements/void_sale-0001-aaaa_001')).toMatchObject({ type: 'sale_void', delta: 2, qtyBefore: 8, qtyAfter: 10 });
    expect(db.get('clients/k1')).toMatchObject({ balance: 0, totalPurchases: 0 });
    expect(db.get('sales/sale-0001-aaaa')).toMatchObject({ status: 'voided', isOpen: false, remaining: 0, remainingAtVoid: 20000, total: 30000 });
    expect(db.get('sale_voids/sale-0001-aaaa')).toMatchObject({ total: 30000, paidTotal: 10000, refundDue: 10000, remainingCancelled: 20000 });
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ voidsCount: 1, voidedTotal: 30000, voidedRefunds: 10000, voidedCredit: 20000, voidedCogs: 20000 });
  });

  it('is idempotent and unknown sales are 404', async () => {
    await svc.createSale(UID, sale());
    await svc.voidSale(UID, 'sale-0001-aaaa', { businessDate: DATE });
    expect((await svc.voidSale(UID, 'sale-0001-aaaa', { businessDate: DATE })).duplicate).toBe(true);
    expect(db.get('products/p1').stockQty).toBe(10); // not restocked twice
    expect(await code(svc.voidSale(UID, 'sale-zzzz-zzzz', { businessDate: DATE }))).toBe('sale_not_found');
  });

  it('a voided sale no longer takes part in FIFO and payments after partial settlement stay consistent', async () => {
    const credit = (id, price) => sale({ saleId: id, clientId: 'k1', cashPaid: 0, lines: [{ productId: 'p1', qty: 1, unitPrice: price }] });
    await svc.createSale(UID, credit('sale-0001-aaaa', 5000));
    await svc.createSale(UID, credit('sale-0002-bbbb', 3000));
    await svc.receivePayment(UID, { paymentId: 'pay-0001-aaaa', clientId: 'k1', amount: 2000, businessDate: DATE, note: '' });
    await svc.voidSale(UID, 'sale-0001-aaaa', { businessDate: DATE }); // had 3000 left, 2000 paid
    expect(db.get('clients/k1').balance).toBe(3000);
    expect(db.get('sale_voids/sale-0001-aaaa').refundDue).toBe(2000);
    await svc.receivePayment(UID, { paymentId: 'pay-0002-bbbb', clientId: 'k1', amount: 3000, businessDate: DATE, note: '' });
    expect(db.get('sales/sale-0002-bbbb')).toMatchObject({ remaining: 0, isOpen: false });
    expect(db.get('clients/k1').balance).toBe(0);
  });
});
