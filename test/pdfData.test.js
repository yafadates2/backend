import { describe, it, expect, beforeEach } from 'vitest';
import { createSalesService } from '../src/sales.js';
import { createPurchasesService } from '../src/purchases.js';
import { createPdfDataService, PdfDataError } from '../src/pdf/data.js';
import { createFakeDb, fieldValue } from './helpers/fakeFirestore.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const D2 = '2026-11-02';
const D3 = '2026-11-03';
const UID = 'u1';

let db; let sales; let purchases; let data;
const code = async (p) => { try { await p; } catch (e) { return e.code ?? `other:${e.message}`; } return null; };

beforeEach(() => {
  db = createFakeDb();
  sales = createSalesService({ db, fieldValue, now: () => NOW });
  purchases = createPurchasesService({ db, fieldValue, now: () => NOW });
  data = createPdfDataService({ db, imageStore: null, now: () => new Date(NOW) });
  db.seed('shop_settings/main', { name: 'تمور يافا', phone: '20000000', address: 'تونس', currencySymbol: 'د.ت', minorUnitDecimals: 3, invoicePrefix: 'TY', allowNegativeStock: false });
  db.seed('products/p1', { name: 'رب 250غ', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 100, isActive: true });
  db.seed('products/p2', { name: 'دهان 250غ', categoryId: 'c1', sellingPrice: 18000, avgCost: 12000, stockQty: 100, isActive: true });
  db.seed('clients/k1', { name: 'سالم', phone: '20111222', address: 'صفاقس', balance: 0, totalPurchases: 0, isArchived: false });
  db.seed('suppliers/s1', { name: 'مورد', phone: '71000000', address: 'تونس', balance: 0, totalPurchases: 0, isArchived: false });
});

const sale = (id, date, over = {}) => ({
  saleId: id, clientId: 'k1', businessDate: date, lines: [{ productId: 'p1', qty: 2 }], discount: 0, cashPaid: 3000, note: '', ...over,
});

describe('shop', () => {
  it('maps settings; money decimals default to 3', async () => {
    expect(await data.shop()).toMatchObject({ name: 'تمور يافا', phone: '20000000', symbol: 'د.ت', decimals: 3, logoDataUri: null });
  });
  it('embeds the logo when available and survives a failing store', async () => {
    db.seed('shop_settings/main', { name: 'x', logoKey: 'shop/a.webp' });
    const ok = createPdfDataService({ db, imageStore: { get: async () => Buffer.from('abc') } });
    expect((await ok.shop()).logoDataUri).toBe(`data:image/webp;base64,${Buffer.from('abc').toString('base64')}`);
    const bad = createPdfDataService({ db, imageStore: { get: async () => { throw new Error('down'); } } });
    expect((await bad.shop()).logoDataUri).toBeNull();
  });
});

describe('bills', () => {
  it('sale bill: snapshot lines, totals, method, client details, void flag', async () => {
    await sales.createSale(UID, sale('sale-0001-aaaa', D3, { lines: [{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1, unitPrice: 17000 }], discount: 1000, cashPaid: 20000 }));
    const b = await data.saleBill('sale-0001-aaaa');
    expect(b).toMatchObject({ kind: 'bill', variant: 'sale', number: 'TY-000001', subtotal: 30000, discount: 1000, total: 29000, paid: 20000, remaining: 9000, methodKey: 'both', voided: null });
    expect(b.party).toEqual({ name: 'سالم', phone: '20111222', address: 'صفاقس' });
    expect(b.lines).toEqual([{ name: 'رب 250غ', qty: 2, unit: 6500, total: 13000 }, { name: 'دهان 250غ', qty: 1, unit: 17000, total: 17000 }]);
    await sales.voidSale(UID, 'sale-0001-aaaa', { businessDate: D3, reason: 'خطأ' });
    expect((await data.saleBill('sale-0001-aaaa')).voided).toEqual({ reason: 'خطأ' });
  });
  it('walk-in cash sale has no party and method cash; archived client still prints', async () => {
    await sales.createSale(UID, sale('sale-0002-bbbb', D3, { clientId: null, cashPaid: 13000 }));
    const b = await data.saleBill('sale-0002-bbbb');
    expect(b.party).toBeNull();
    expect(b.methodKey).toBe('cash');
    await sales.createSale(UID, sale('sale-0003-cccc', D3, { cashPaid: 0 }));
    db.seed('clients/k1', { name: 'سالم', balance: 13000, isArchived: true });
    const c = await data.saleBill('sale-0003-cccc');
    expect(c.party.name).toBe('سالم');
    expect(c.methodKey).toBe('credit');
  });
  it('purchase bill: unit cost, extra costs, supplier ref', async () => {
    await purchases.createPurchase(UID, { purchaseId: 'buy-0001-aaaa', supplierId: 's1', invoiceRef: 'F-77', businessDate: D3, lines: [{ productId: 'p1', qty: 10, unitCost: 5000 }], discount: 0, extraCosts: 2000, cashPaid: 20000, note: '' });
    const b = await data.purchaseBill('buy-0001-aaaa');
    expect(b).toMatchObject({ variant: 'purchase', number: 'TY-P-000001', invoiceRef: 'F-77', subtotal: 50000, extraCosts: 2000, total: 52000, paid: 20000, remaining: 32000, methodKey: 'both' });
    expect(b.lines).toEqual([{ name: 'رب 250غ', qty: 10, unit: 5000, total: 50000 }]);
  });
  it('unknown ids are not_found', async () => {
    expect(await code(data.saleBill('nope'))).toBe('not_found');
    expect(await code(data.purchaseBill('nope'))).toBe('not_found');
    expect(await code(data.receipt('customer', 'nope'))).toBe('not_found');
  });
});

describe('receipts', () => {
  it('customer receipt lists settled invoice numbers; balance is the current one', async () => {
    await sales.createSale(UID, sale('sale-0001-aaaa', D3, { cashPaid: 3000 })); // credit 10000
    await sales.createSale(UID, sale('sale-0002-bbbb', D3, { cashPaid: 0 }));    // credit 13000
    await sales.receivePayment(UID, { paymentId: 'pay-0001-aaaa', clientId: 'k1', amount: 15000, businessDate: D3, note: 'نقدا' });
    const r = await data.receipt('customer', 'pay-0001-aaaa');
    expect(r).toMatchObject({ variant: 'customer', number: 'TY-R-000001', amount: 15000, balanceNow: 8000, note: 'نقدا' });
    expect(r.allocations).toEqual([{ number: 'TY-000001', amount: 10000 }, { number: 'TY-000002', amount: 5000 }]);
  });
  it('supplier receipt', async () => {
    await purchases.createPurchase(UID, { purchaseId: 'buy-0001-aaaa', supplierId: 's1', invoiceRef: '', businessDate: D3, lines: [{ productId: 'p1', qty: 10, unitCost: 5000 }], discount: 0, extraCosts: 0, cashPaid: 0, note: '' });
    await purchases.paySupplier(UID, { paymentId: 'spay-0001-aaaa', supplierId: 's1', amount: 20000, businessDate: D3, note: '' });
    const r = await data.receipt('supplier', 'spay-0001-aaaa');
    expect(r).toMatchObject({ variant: 'supplier', number: 'TY-S-000001', amount: 20000, balanceNow: 30000 });
    expect(r.allocations).toEqual([{ number: 'TY-P-000001', amount: 20000 }]);
  });
});

describe('client statement', () => {
  beforeEach(async () => {
    await sales.createSale(UID, sale('sale-0001-aaaa', D2, { cashPaid: 3000 }));            // +10000 on 02/11
    await sales.receivePayment(UID, { paymentId: 'pay-0001-aaaa', clientId: 'k1', amount: 4000, businessDate: D3, note: '' }); // -4000 on 03/11
    await sales.createSale(UID, sale('sale-0002-bbbb', D3, { cashPaid: 0 }));              // +13000 on 03/11
    await sales.voidSale(UID, 'sale-0002-bbbb', { businessDate: D3, reason: '' });          // -13000 on 03/11
    await sales.createSale(UID, sale('sale-0003-cccc', D3, { cashPaid: 13000 }));          // cash: no balance effect, not listed
  });
  it('rows run a balance that ends exactly on the client balance', async () => {
    const st = await data.statement('client', 'k1', '2026-11-01', '2026-11-30');
    const bal = db.get('clients/k1').balance;
    expect(bal).toBe(6000);
    expect(st.opening).toBe(0);
    expect(st.closing).toBe(bal);
    expect(st.balanceNow).toBe(bal);
    expect(st.rows.map((r) => [r.labelKey, r.debit, r.credit, r.balance])).toEqual([
      ['saleEntry', 10000, 0, 10000],
      ['paymentEntry', 0, 4000, 6000],
      ['saleEntry', 13000, 0, 19000],
      ['voidEntry', 0, 13000, 6000],
    ]);
  });
  it('a later period derives its opening balance from the history', async () => {
    const st = await data.statement('client', 'k1', D3, D3);
    expect(st.opening).toBe(10000);
    expect(st.closing).toBe(6000);
    expect(st.rows).toHaveLength(3);
  });
  it('an earlier period closes before later movements', async () => {
    const st = await data.statement('client', 'k1', '2026-10-01', D2);
    expect(st.opening).toBe(0);
    expect(st.closing).toBe(10000);
    expect(st.balanceNow).toBe(6000);
  });
  it('validates the period and the client', async () => {
    expect(await code(data.statement('client', 'k1', '2026-11-05', '2026-11-01'))).toBe('invalid_period');
    expect(await code(data.statement('client', 'k1', '2025-01-01', '2026-11-01'))).toBe('period_too_long');
    expect(await code(data.statement('client', 'zzz', D2, D3))).toBe('not_found');
  });
});

describe('supplier statement', () => {
  it('purchase on account, payment, closing equals the supplier balance', async () => {
    await purchases.createPurchase(UID, { purchaseId: 'buy-0001-aaaa', supplierId: 's1', invoiceRef: '', businessDate: D2, lines: [{ productId: 'p1', qty: 10, unitCost: 5000 }], discount: 0, extraCosts: 0, cashPaid: 20000, note: '' });
    await purchases.paySupplier(UID, { paymentId: 'spay-0001-aaaa', supplierId: 's1', amount: 10000, businessDate: D3, note: '' });
    const st = await data.statement('supplier', 's1', '2026-11-01', '2026-11-30');
    expect(st.rows.map((r) => [r.labelKey, r.debit, r.credit, r.balance])).toEqual([['purchaseEntry', 30000, 0, 30000], ['paymentEntry', 0, 10000, 20000]]);
    expect(st.closing).toBe(db.get('suppliers/s1').balance);
  });
});

describe('expense report', () => {
  beforeEach(() => {
    const e = (id, over) => db.seed(`expenses/${id}`, { number: `TY-E-${id}`, title: id, amount: 1000, categoryId: 'rent', categoryName: 'كراء', businessDate: D3, isArchived: false, ...over });
    e('a', { amount: 2000 });
    e('b', { categoryId: 'water', categoryName: 'ماء', businessDate: D2 });
    e('c', { isArchived: true, amount: 99999 });
    e('d', { businessDate: '2026-10-01' });
    db.seed('expense_categories/rent', { name: 'كراء' });
  });
  it('excludes archived and out-of-period; totals per category', async () => {
    const r = await data.expenseReport({ from: '2026-11-01', to: '2026-11-30' });
    expect(r.count).toBe(2);
    expect(r.total).toBe(3000);
    expect(r.byCategory).toEqual([{ name: 'كراء', count: 1, total: 2000 }, { name: 'ماء', count: 1, total: 1000 }]);
    expect(r.rows[0]).toMatchObject({ number: 'TY-E-a', dateText: '03/11/2026' });
    expect(r.truncated).toBe(false);
  });
  it('category filter', async () => {
    const r = await data.expenseReport({ from: '2026-11-01', to: '2026-11-30', categoryId: 'rent' });
    expect(r).toMatchObject({ count: 1, total: 2000, categoryName: 'كراء' });
  });
  it('validates the period', async () => {
    expect(await code(data.expenseReport({ from: 'x', to: D3 }))).toBe('invalid_period');
  });
});

describe('sales report', () => {
  it('per-day net, profit (net of voided cost) and the invoice list', async () => {
    await sales.createSale(UID, sale('sale-0001-aaaa', D2, { cashPaid: 13000 }));              // 13000, cost 8000
    await sales.createSale(UID, sale('sale-0002-bbbb', D3, { cashPaid: 0 }));                  // 13000, cost 8000
    await sales.voidSale(UID, 'sale-0002-bbbb', { businessDate: D3, reason: '' });
    await sales.receivePayment(UID, { paymentId: 'pay-0001-aaaa', clientId: 'k1', amount: 1000, businessDate: D3, note: '' }).catch(() => {}); // nothing due after the void: ignored
    const r = await data.salesReport({ from: '2026-11-01', to: '2026-11-30' });
    expect(r.days.map((d) => [d.dateText, d.gross, d.voided, d.net, d.profit])).toEqual([
      ['02/11/2026', 13000, 0, 13000, 5000],
      ['03/11/2026', 13000, 13000, 0, 0],
    ]);
    expect(r.totals).toMatchObject({ salesCount: 2, gross: 26000, voided: 13000, net: 13000, profit: 5000 });
    expect(r.sales.map((s) => [s.number, s.voided])).toEqual(expect.arrayContaining([['TY-000001', false], ['TY-000002', true]]));
    expect(r.truncated).toBe(false);
  });
  it('an empty period is an empty report, not an error', async () => {
    const r = await data.salesReport({ from: '2026-11-01', to: '2026-11-30' });
    expect(r.days).toEqual([]);
    expect(r.totals.net).toBe(0);
  });
});

describe('profit report', () => {
  it('net profit = sales - voids - cost of sales - expenses; cash in nets refunds; purchases net', async () => {
    await sales.createSale(UID, sale('sale-0001-aaaa', D3, { cashPaid: 13000 }));              // 13000, cost 8000, cash 13000
    await sales.createSale(UID, sale('sale-0002-bbbb', D3, { cashPaid: 3000, discount: 1000 })); // 12000, cost 8000, credit 9000
    await sales.voidSale(UID, 'sale-0002-bbbb', { businessDate: D3, reason: '' });
    await purchases.createPurchase(UID, { purchaseId: 'buy-0001-aaaa', supplierId: 's1', invoiceRef: '', businessDate: D2, lines: [{ productId: 'p1', qty: 10, unitCost: 5000 }], discount: 0, extraCosts: 0, cashPaid: 20000, note: '' });
    const stats2 = (await db.collection('daily_stats').doc(D2).get()).data();
    db.seed(`daily_stats/${D2}`, { ...stats2, expensesCount: 1, expensesTotal: 2500 });
    const r = await data.profitReport({ from: '2026-11-01', to: '2026-11-30' });
    expect(r.totals).toMatchObject({
      gross: 25000, voided: 12000, net: 13000, cogs: 8000, grossProfit: 5000, expenses: 2500, netProfit: 2500,
      cashIn: 13000, purchases: 50000, supplierPaid: 0, discounts: 1000,
    });
    expect(r.days.map((d) => [d.dateText, d.netProfit])).toEqual([['02/11/2026', -2500], ['03/11/2026', 5000]]);
  });
  it('empty period is an empty report; invalid periods are rejected', async () => {
    const r = await data.profitReport({ from: '2026-11-01', to: '2026-11-30' });
    expect(r.days).toEqual([]);
    expect(r.totals.netProfit).toBe(0);
    expect(await code(data.profitReport({ from: '2026-11-30', to: '2026-11-01' }))).toBe('invalid_period');
    expect(await code(data.profitReport({ from: '2024-01-01', to: '2026-11-01' }))).toBe('period_too_long');
  });
});

it('PdfDataError carries status and code', () => {
  expect(new PdfDataError('not_found', 404)).toMatchObject({ code: 'not_found', status: 404 });
});
