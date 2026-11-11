import { describe, it, expect, beforeEach } from 'vitest';
import { createSalesService } from '../src/sales.js';
import { createPurchasesService } from '../src/purchases.js';
import { createOrdersService } from '../src/orders.js';
import { createNotifier, availableMessage } from '../src/notifications.js';
import { createFakeDb, fieldValue } from './helpers/fakeFirestore.js';

const NOW = Date.UTC(2026, 10, 10, 12);
const DATE = '2026-11-10';
const UID = 'u1';
const code = async (p) => { try { await p; } catch (e) { return e.code ?? `other:${e.message}`; } return null; };

let db; let sales; let purchases; let orders; let pushes;

beforeEach(() => {
  db = createFakeDb();
  pushes = [];
  const notifier = { orderAvailable: async (o) => { pushes.push(o); } };
  let svc;
  const onStockChanged = (ids) => svc.checkProducts(ids);
  sales = createSalesService({ db, fieldValue, now: () => NOW, onStockChanged });
  purchases = createPurchasesService({ db, fieldValue, now: () => NOW, onStockChanged });
  svc = createOrdersService({ db, fieldValue, sales, notifier, now: () => NOW });
  orders = svc;
  db.seed('shop_settings/main', { allowNegativeStock: false, invoicePrefix: 'TY' });
  db.seed('products/p1', { name: 'تمر دقلة', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 0, isActive: true });
  db.seed('products/p2', { name: 'عسل', categoryId: 'c1', sellingPrice: 18000, avgCost: 12000, stockQty: 1, isActive: true });
  db.seed('products/off', { name: 'قديم', categoryId: 'c1', sellingPrice: 1000, avgCost: 0, stockQty: 5, isActive: false });
  db.seed('suppliers/s1', { name: 'مورد', balance: 0, totalPurchases: 0, isArchived: false });
});

const order = (over = {}) => ({
  orderId: 'order-0001-aaaa', customerName: 'سالم', customerPhone: '98123456',
  lines: [{ productId: 'p1', qty: 3 }, { productId: 'p2', qty: 1, unitPrice: 17000 }],
  expectedDate: null, notes: '', ...over,
});
const receive = (qty, id = 'pur-0001-aaaa') => purchases.createPurchase(UID, {
  purchaseId: id, supplierId: 's1', invoiceRef: '', businessDate: DATE,
  lines: [{ productId: 'p1', qty, unitCost: 4000 }], discount: 0, extraCosts: 0, cashPaid: qty * 4000,
});

describe('createOrder', () => {
  it('records the order with price snapshots and touches NO stock, sale or movement', async () => {
    const r = await orders.createOrder(UID, order());
    expect(r).toMatchObject({ id: 'order-0001-aaaa', number: 'TY-O-000001', status: 'pending', total: 3 * 6500 + 17000, duplicate: false });
    const o = db.get('customer_orders/order-0001-aaaa');
    expect(o.lines).toEqual([
      { productId: 'p1', productName: 'تمر دقلة', qty: 3, unitPrice: 6500 },
      { productId: 'p2', productName: 'عسل', qty: 1, unitPrice: 17000 },
    ]);
    expect(o).toMatchObject({ isOpen: true, expectedDate: null, availabilityEvents: 0, saleId: null, watchProductIds: ['p1', 'p2'] });
    expect(db.get('products/p1').stockQty).toBe(0);
    expect(db.get('products/p2').stockQty).toBe(1);
    expect([...db.store.keys()].filter((k) => k.startsWith('sales/') || k.startsWith('stock_movements/'))).toEqual([]);
    expect(db.get('counters/sales')).toBeUndefined();
    expect(pushes).toHaveLength(0);
  });

  it('keeps a specific expected date for reference, and rejects impossible ones', async () => {
    await orders.createOrder(UID, order({ expectedDate: '2026-12-01' }));
    expect(db.get('customer_orders/order-0001-aaaa').expectedDate).toBe('2026-12-01');
    expect(await code(orders.createOrder(UID, order({ orderId: 'order-0002-aaaa', expectedDate: '2026-02-30' })))).toBe('invalid_expected_date');
  });

  it('is available at once when stock already covers it (no push: the admin is looking at it)', async () => {
    const r = await orders.createOrder(UID, order({ lines: [{ productId: 'p2', qty: 1 }] }));
    expect(r.status).toBe('available');
    expect(pushes).toHaveLength(0);
  });

  it('is idempotent: same id + same content = same order; other content = conflict', async () => {
    await orders.createOrder(UID, order());
    expect(await orders.createOrder(UID, order())).toMatchObject({ duplicate: true, number: 'TY-O-000001' });
    expect(db.get('counters/customer_orders')).toEqual({ value: 1 });
    expect(await code(orders.createOrder(UID, order({ customerName: 'غيره' })))).toBe('idempotency_conflict');
  });

  it('rejects unknown / archived / duplicate products', async () => {
    expect(await code(orders.createOrder(UID, order({ lines: [{ productId: 'nope', qty: 1 }] })))).toBe('product_not_found');
    expect(await code(orders.createOrder(UID, order({ lines: [{ productId: 'off', qty: 1 }] })))).toBe('product_inactive');
    expect(await code(orders.createOrder(UID, order({ lines: [{ productId: 'p1', qty: 1 }, { productId: 'p1', qty: 2 }] })))).toBe('duplicate_product');
  });
});

describe('availability detection', () => {
  beforeEach(async () => { await orders.createOrder(UID, order()); });

  it('a purchase that covers every line flips the order to available and pushes ONCE', async () => {
    await receive(2); // p1 stock 2 < 3 -> still pending
    expect(db.get('customer_orders/order-0001-aaaa').status).toBe('pending');
    expect(pushes).toHaveLength(0);
    await receive(1, 'pur-0002-aaaa'); // p1 stock 3, p2 stock 1 -> all there
    expect(db.get('customer_orders/order-0001-aaaa')).toMatchObject({ status: 'available', availabilityEvents: 1 });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ id: 'order-0001-aaaa', number: 'TY-O-000001', customerName: 'سالم' });
  });

  it('repeated / concurrent checks never send a second push for the same event', async () => {
    db.seed('products/p1', { name: 'تمر دقلة', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 5, isActive: true });
    await Promise.all([orders.checkProducts(['p1']), orders.checkAll(), orders.checkProducts(['p1', 'p2'])]);
    await orders.checkAll();
    expect(pushes).toHaveLength(1);
    expect(db.get('customer_orders/order-0001-aaaa').availabilityEvents).toBe(1);
  });

  it('available goes back to pending when stock falls again (no push), then a NEW event pushes again', async () => {
    await receive(3);
    expect(pushes).toHaveLength(1);
    await sales.createSale(UID, { saleId: 'sale-0001-aaaa', businessDate: DATE, lines: [{ productId: 'p1', qty: 2 }], discount: 0, cashPaid: 13000, note: '' });
    expect(db.get('customer_orders/order-0001-aaaa').status).toBe('pending');
    expect(pushes).toHaveLength(1);
    await receive(2, 'pur-0003-aaaa');
    expect(db.get('customer_orders/order-0001-aaaa')).toMatchObject({ status: 'available', availabilityEvents: 2 });
    expect(pushes).toHaveLength(2);
  });

  it('checkAll is the safety net when a stock edit never reported itself', async () => {
    db.seed('products/p1', { name: 'تمر دقلة', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 9, isActive: true });
    const r = await orders.checkAll();
    expect(r).toMatchObject({ checked: 1, becameAvailable: 1 });
    expect(pushes).toHaveLength(1);
  });

  it('a failing push does not undo the status change', async () => {
    const bad = createOrdersService({ db, fieldValue, sales, notifier: { orderAvailable: async () => { throw new Error('fcm down'); } }, now: () => NOW });
    db.seed('products/p1', { name: 'x', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 9, isActive: true });
    await bad.checkAll();
    expect(db.get('customer_orders/order-0001-aaaa').status).toBe('available');
  });

  it('the requested date arriving changes nothing by itself', async () => {
    await orders.createOrder(UID, order({ orderId: 'order-0002-aaaa', expectedDate: '2026-11-01' })); // date already passed
    const o = db.get('customer_orders/order-0002-aaaa');
    expect(o).toMatchObject({ status: 'pending', expectedDate: '2026-11-01' });
    expect(db.get('products/p1').stockQty).toBe(0);
  });
});

describe('notify / edit / cancel', () => {
  beforeEach(async () => { await orders.createOrder(UID, order({ lines: [{ productId: 'p2', qty: 1 }] })); }); // available

  it('available -> notified (stops being watched); pending cannot be marked notified', async () => {
    await orders.createOrder(UID, order({ orderId: 'order-0002-aaaa' }));
    expect(await code(orders.markNotified(UID, 'order-0002-aaaa'))).toBe('invalid_status');
    expect((await orders.markNotified(UID, 'order-0001-aaaa')).status).toBe('notified');
    expect(db.get('customer_orders/order-0001-aaaa').watchProductIds).toEqual([]);
    expect((await orders.markNotified(UID, 'order-0001-aaaa')).duplicate).toBe(true);
  });

  it('edits contact details and date while open; never the lines', async () => {
    await orders.updateOrder(UID, 'order-0001-aaaa', { customerPhone: '+21698123456', expectedDate: '2026-12-24', notes: 'ن' });
    expect(db.get('customer_orders/order-0001-aaaa')).toMatchObject({ customerPhone: '+21698123456', expectedDate: '2026-12-24', notes: 'ن', status: 'available' });
    await orders.updateOrder(UID, 'order-0001-aaaa', { expectedDate: null });
    expect(db.get('customer_orders/order-0001-aaaa').expectedDate).toBeNull();
    expect(await code(orders.updateOrder(UID, 'nope-0000-0001', {}))).toBe('order_not_found');
  });

  it('cancel closes the order without touching stock; it cannot be edited or completed afterwards', async () => {
    await orders.cancelOrder(UID, 'order-0001-aaaa', { reason: 'لم يعد يريد' });
    expect(db.get('customer_orders/order-0001-aaaa')).toMatchObject({ status: 'cancelled', isOpen: false, watchProductIds: [] });
    expect(db.get('products/p2').stockQty).toBe(1);
    expect(await code(orders.updateOrder(UID, 'order-0001-aaaa', { notes: 'x' }))).toBe('order_closed');
    expect(await code(orders.completeOrder(UID, 'order-0001-aaaa', { businessDate: DATE }))).toBe('order_closed');
    expect((await orders.cancelOrder(UID, 'order-0001-aaaa')).duplicate).toBe(true);
  });
});

describe('completeOrder', () => {
  beforeEach(async () => {
    await orders.createOrder(UID, order());
    await receive(3);
  });

  it('creates the sale at the ORDER price, deducts stock, links both ways, in one commit', async () => {
    const r = await orders.completeOrder(UID, 'order-0001-aaaa', { businessDate: DATE });
    expect(r).toMatchObject({ status: 'completed', saleId: 'ord_order-0001-aaaa', saleNumber: 'TY-000001', duplicate: false });
    expect(db.get('sales/ord_order-0001-aaaa')).toMatchObject({ total: 36500, cashPaid: 36500, credit: 0, status: 'active', clientId: null });
    expect(db.get('sales/ord_order-0001-aaaa').note).toContain('TY-O-000001');
    expect(db.get('sales/ord_order-0001-aaaa/sale_items/002')).toMatchObject({ productId: 'p2', unitPrice: 17000 });
    expect(db.get('products/p1').stockQty).toBe(0);
    expect(db.get('products/p2').stockQty).toBe(0);
    expect(db.get('customer_orders/order-0001-aaaa')).toMatchObject({ status: 'completed', isOpen: false, saleId: 'ord_order-0001-aaaa', watchProductIds: [] });
    expect(db.get(`daily_stats/${DATE}`)).toMatchObject({ salesCount: 1, salesTotal: 36500 });
  });

  it('a double tap / retry returns the same result and never sells twice', async () => {
    await orders.completeOrder(UID, 'order-0001-aaaa', { businessDate: DATE });
    const again = await orders.completeOrder(UID, 'order-0001-aaaa', { businessDate: DATE });
    expect(again).toMatchObject({ duplicate: true, saleId: 'ord_order-0001-aaaa' });
    expect(db.get('counters/sales')).toEqual({ value: 1 });
    expect(db.get('products/p1').stockQty).toBe(0); // not -3
    expect(db.get(`daily_stats/${DATE}`).salesCount).toBe(1);
  });

  it('without enough stock nothing is written (order stays open, no sale, no stock change)', async () => {
    db.seed('products/p1', { name: 'x', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 1, isActive: true });
    expect(await code(orders.completeOrder(UID, 'order-0001-aaaa', { businessDate: DATE }))).toBe('insufficient_stock');
    expect(db.get('customer_orders/order-0001-aaaa').status).not.toBe('completed');
    expect(db.get('sales/ord_order-0001-aaaa')).toBeUndefined();
    expect(db.get('products/p1').stockQty).toBe(1);
  });

  it('works from notified too, and completing lowers stock so other waiting orders fall back to pending', async () => {
    await orders.createOrder(UID, order({ orderId: 'order-0002-aaaa' }));
    await orders.checkAll();
    expect(db.get('customer_orders/order-0002-aaaa').status).toBe('available');
    await orders.markNotified(UID, 'order-0001-aaaa');
    await orders.completeOrder(UID, 'order-0001-aaaa', { businessDate: DATE });
    await new Promise((r) => setTimeout(r, 20)); // post-completion check is fire-and-forget
    expect(db.get('customer_orders/order-0002-aaaa').status).toBe('pending');
  });

  it('rejects a bad business date and an unknown order', async () => {
    expect(await code(orders.completeOrder(UID, 'order-0001-aaaa', { businessDate: '2020-01-01' }))).toBe('invalid_business_date');
    expect(await code(orders.completeOrder(UID, 'nope-0000-0001', { businessDate: DATE }))).toBe('order_not_found');
  });
});

describe('notifier', () => {
  const order = { id: 'o1', number: 'TY-O-000001', customerName: 'سالم', lines: [{ productName: 'تمر', qty: 1 }, { productName: 'عسل', qty: 2 }] };
  it('texts per language', () => {
    expect(availableMessage('fr', order)).toEqual({ title: 'Commande client disponible', body: 'سالم : تمر +1 (TY-O-000001)' });
    expect(availableMessage('ar', order).body).toBe('سالم: تمر +1 (TY-O-000001)');
  });
  it('registers, pushes per language, prunes dead tokens, and only the owner can unregister', async () => {
    const calls = [];
    const messaging = {
      sendEachForMulticast: async (m) => { calls.push(m); return { responses: m.tokens.map((t) => (t.startsWith('dead') ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true })) }; },
    };
    const n = createNotifier({ db, messaging, now: () => NOW });
    const tok = (s) => s.padEnd(24, 'x');
    await n.registerDevice('u1', { token: tok('good-ar'), lang: 'ar' });
    await n.registerDevice('u1', { token: tok('dead-fr'), lang: 'fr' });
    await n.registerDevice('u2', { token: tok('good-fr'), lang: 'fr' });
    const r = await n.orderAvailable(order);
    expect(r.sent).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.notification.title.startsWith('Commande'))).toMatchObject({ data: { type: 'customer_order_available', orderId: 'o1' }, android: { notification: { tag: 'o1' } } });
    expect(db.collection('device_tokens').__run().docs).toHaveLength(2); // dead token pruned
    await n.unregisterDevice('u1', tok('good-fr')); // not u1's device
    expect(db.collection('device_tokens').__run().docs).toHaveLength(2);
    await n.unregisterDevice('u2', tok('good-fr'));
    expect(db.collection('device_tokens').__run().docs).toHaveLength(1);
  });
});
