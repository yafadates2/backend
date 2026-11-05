import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/reconcile.js';
import { createSalesService } from '../src/sales.js';
import { createFakeDb, fieldValue } from './helpers/fakeFirestore.js';

const DATE = '2026-11-03';

// Drive the real service on the fake DB, then check that reconcile finds nothing.
async function scenario() {
  const db = createFakeDb();
  const svc = createSalesService({ db, fieldValue, now: () => Date.UTC(2026, 10, 3, 12) });
  db.seed('shop_settings/main', { allowNegativeStock: false, invoicePrefix: 'TY' });
  db.seed('products/p1', { name: 'a', categoryId: 'c', sellingPrice: 6500, avgCost: 4000, stockQty: 0, isActive: true });
  db.seed('clients/k1', { name: 'k', balance: 0, totalPurchases: 0, isArchived: false });
  // opening stock the way Phase 4 records it
  db.seed('stock_movements/open1', { productId: 'p1', type: 'stock_in', delta: 20, qtyBefore: 0, qtyAfter: 20 });
  db.seed('products/p1', { name: 'a', categoryId: 'c', sellingPrice: 6500, avgCost: 4000, stockQty: 20, isActive: true });
  const s = (id, over) => ({ saleId: id, clientId: 'k1', businessDate: DATE, lines: [{ productId: 'p1', qty: 2 }], discount: 500, cashPaid: 3000, note: '', ...over });
  await svc.createSale('u', s('sale-0001-aaaa'));
  await svc.createSale('u', s('sale-0002-bbbb', { cashPaid: 0 }));
  await svc.createSale('u', s('sale-0003-cccc', { cashPaid: 12500 }));
  await svc.receivePayment('u', { paymentId: 'pay-0001-aaaa', clientId: 'k1', amount: 5000, businessDate: DATE, note: '' });
  await svc.voidSale('u', 'sale-0002-bbbb', { businessDate: DATE, reason: '' });
  return db;
}

const load = (db) => {
  const list = (prefix) => [...db.store.entries()]
    .filter(([p]) => p.startsWith(`${prefix}/`) && !p.slice(prefix.length + 1).includes('/'))
    .map(([p, d]) => ({ id: p.split('/').pop(), ...d }));
  const sales = list('sales');
  const items = {};
  for (const s of sales) items[s.id] = list(`sales/${s.id}/sale_items`);
  return {
    products: list('products'), movements: list('stock_movements'), clients: list('clients'),
    sales, items, voids: list('sale_voids'), stats: list('daily_stats'),
  };
};

describe('reconcile', () => {
  it('finds nothing after a realistic sequence of sales, a payment and a void', async () => {
    expect(reconcile(load(await scenario()))).toEqual([]);
  });
  it('detects a tampered client balance, product stock and daily stat', async () => {
    const db = await scenario();
    const data = load(db);
    data.clients[0].balance += 1;
    data.products[0].stockQty += 1;
    data.stats[0].salesTotal += 1;
    const kinds = reconcile(data).map((i) => i.kind).sort();
    expect(kinds).toEqual(['client_balance', 'daily_stats', 'stock_mismatch']);
  });
});

// ---------- Phase 7: purchases ----------
import { createPurchasesService } from '../src/purchases.js';

async function purchaseScenario() {
  const db = createFakeDb();
  const now = () => Date.UTC(2026, 10, 3, 12);
  const buy = createPurchasesService({ db, fieldValue, now });
  db.seed('shop_settings/main', { allowNegativeStock: false, invoicePrefix: 'TY' });
  db.seed('products/p1', { name: 'a', categoryId: 'c', sellingPrice: 6500, avgCost: 0, stockQty: 0, isActive: true });
  db.seed('suppliers/s1', { name: 's', balance: 0, totalPurchases: 0, isArchived: false });
  const p = (id, over) => ({ purchaseId: id, supplierId: 's1', invoiceRef: '', businessDate: DATE, lines: [{ productId: 'p1', qty: 10, unitCost: 3000 }], discount: 1000, extraCosts: 2500, cashPaid: 5000, note: '', ...over });
  await buy.createPurchase('u', p('buy-0001-aaaa'));
  await buy.createPurchase('u', p('buy-0002-bbbb', { cashPaid: 0 }));
  await buy.paySupplier('u', { paymentId: 'spay-0001-aaaa', supplierId: 's1', amount: 10000, businessDate: DATE, note: '' });
  await buy.voidPurchase('u', 'buy-0002-bbbb', { businessDate: DATE, reason: '' });
  return db;
}

const loadAll = (db) => {
  const list = (prefix) => [...db.store.entries()]
    .filter(([p]) => p.startsWith(`${prefix}/`) && !p.slice(prefix.length + 1).includes('/'))
    .map(([p, d]) => ({ id: p.split('/').pop(), ...d }));
  const purchases = list('purchases');
  const purchaseItems = {};
  for (const x of purchases) purchaseItems[x.id] = list(`purchases/${x.id}/purchase_items`);
  return {
    products: list('products'), movements: list('stock_movements'), clients: [], sales: [], stats: list('daily_stats'),
    suppliers: list('suppliers'), purchases, purchaseItems, purchaseVoids: list('purchase_voids'), supplierPayments: list('supplier_payments'),
  };
};

describe('reconcile purchases', () => {
  it('finds nothing after purchases, a supplier payment and a void', async () => {
    expect(reconcile(loadAll(await purchaseScenario()))).toEqual([]);
  });
  it('detects tampered supplier balance, purchase total, landed sum, stats and missing void doc', async () => {
    const data = loadAll(await purchaseScenario());
    data.suppliers[0].balance += 1;
    data.purchases[0].total += 1;
    data.purchaseItems[data.purchases[1].id][0].landedTotal += 1;
    data.stats[0].purchasesCash += 1;
    data.stats[0].supplierPaymentsPaid += 1;
    data.purchaseVoids = [];
    const kinds = new Set(reconcile(data).map((i) => i.kind));
    for (const k of ['supplier_balance', 'purchase_total', 'purchase_items', 'daily_stats_purchases', 'daily_stats_supplier_payments', 'purchase_void_missing']) {
      expect(kinds.has(k)).toBe(true);
    }
  });
});
