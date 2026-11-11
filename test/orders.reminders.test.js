import { describe, it, expect, beforeEach } from 'vitest';
import { createOrdersService } from '../src/orders.js';
import { createNotifier, expectedTodayMessage } from '../src/notifications.js';
import { businessDateAt, isPastReminderTime, nextRunAfter, startDailyReminders } from '../src/reminders.js';
import { createFakeDb, fieldValue } from './helpers/fakeFirestore.js';

// Tunisia is UTC+1 all year, so 08:00 in Tunis is 07:00 UTC.
const at = (iso) => Date.parse(iso);
const MORNING = at('2026-11-11T07:00:30Z'); // 08:00:30 on 2026-11-11 in Tunis
const TODAY = '2026-11-11';
const UID = 'u1';

let db; let pushes; let now; let notifierImpl;

const makeOrders = () => {
  const sales = {}; // the reminder job never touches sales
  const notifier = { orderAvailable: async () => {}, orderExpectedToday: (o) => notifierImpl(o) };
  return createOrdersService({ db, fieldValue, sales, notifier, now: () => now });
};

const seedOrder = (id, over = {}) => db.seed(`customer_orders/${id}`, {
  number: `TY-O-${id}`, customerName: 'سالم', status: 'pending', isOpen: true, expectedDate: TODAY,
  lines: [{ productId: 'p1', productName: 'تمر', qty: 3, unitPrice: 6500 }], watchProductIds: ['p1'], ...over,
});

beforeEach(() => {
  db = createFakeDb();
  now = MORNING;
  pushes = [];
  notifierImpl = async (o) => { pushes.push(o); return { sent: 1 }; };
  db.seed('shop_settings/main', { allowNegativeStock: false, invoicePrefix: 'TY' });
  db.seed('products/p1', { name: 'تمر', categoryId: 'c1', sellingPrice: 6500, avgCost: 4000, stockQty: 0, isActive: true });
});

describe('sendDueReminders', () => {
  it('reminds every open order expected today, whatever its stock status', async () => {
    seedOrder('pend'); // stock 0 -> still pending
    seedOrder('avail', { status: 'available' });
    seedOrder('noti', { status: 'notified', watchProductIds: [] });
    const r = await makeOrders().sendDueReminders();
    expect(r).toEqual({ date: TODAY, due: 3, sent: 3, skipped: 0, undelivered: 0 });
    expect(pushes.map((o) => o.id).sort()).toEqual(['avail', 'noti', 'pend']);
    expect(pushes[0]).toMatchObject({ expectedDate: TODAY, customerName: 'سالم', lines: [{ productName: 'تمر', qty: 3 }] });
    expect(db.get('customer_orders/pend').expectedReminderFor).toBe(TODAY);
  });

  it('ignores completed and cancelled orders, other dates and orders without a date', async () => {
    seedOrder('done', { status: 'completed', isOpen: false });
    seedOrder('gone', { status: 'cancelled', isOpen: false });
    seedOrder('later', { expectedDate: '2026-11-12' });
    seedOrder('past', { expectedDate: '2026-11-10' });
    seedOrder('nodate', { expectedDate: null });
    const r = await makeOrders().sendDueReminders();
    expect(r).toMatchObject({ date: TODAY, sent: 0, undelivered: 0 });
    expect(pushes).toEqual([]);
    expect(db.get('customer_orders/done').expectedReminderFor).toBeUndefined();
  });

  it('sends at most one reminder per order and date: repeated runs, a restart and racing runs add nothing', async () => {
    seedOrder('a'); seedOrder('b');
    await makeOrders().sendDueReminders();
    expect(pushes).toHaveLength(2);
    const again = await makeOrders().sendDueReminders(); // "restart": a brand new service instance
    expect(again).toMatchObject({ due: 2, sent: 0, skipped: 2 });
    now += 3 * 3600_000; // later the same day
    await makeOrders().sendDueReminders();
    expect(pushes).toHaveLength(2);

    seedOrder('c');
    const [x, y] = await Promise.all([makeOrders().sendDueReminders(), makeOrders().sendDueReminders()]); // two instances at once
    expect(pushes.filter((o) => o.id === 'c')).toHaveLength(1);
    expect(x.sent + y.sent).toBe(1);
  });

  it('a new expected date gets its own reminder; going back to an already-reminded date does not repeat it', async () => {
    seedOrder('a');
    const svc = makeOrders();
    await svc.sendDueReminders();
    await svc.updateOrder(UID, 'a', { expectedDate: '2026-11-12' });
    await svc.sendDueReminders(); // not due today any more
    expect(pushes).toHaveLength(1);
    now = at('2026-11-12T07:00:30Z');
    await svc.sendDueReminders();
    expect(pushes).toHaveLength(2);
    expect(db.get('customer_orders/a').expectedReminderFor).toBe('2026-11-12');
    await svc.updateOrder(UID, 'a', { expectedDate: '2026-11-12' });
    await svc.sendDueReminders();
    expect(pushes).toHaveLength(2);
  });

  it('gives the claim back when nobody was reached, so a later run retries (and then stops)', async () => {
    seedOrder('a'); seedOrder('b');
    notifierImpl = async (o) => { if (o.id === 'a') throw new Error('fcm down'); return { sent: 0 }; };
    const first = await makeOrders().sendDueReminders();
    expect(first).toMatchObject({ sent: 0, undelivered: 2 });
    expect(db.get('customer_orders/a').expectedReminderFor).toBeNull();
    notifierImpl = async (o) => { pushes.push(o); return { sent: 2 }; };
    const second = await makeOrders().sendDueReminders();
    expect(second).toMatchObject({ sent: 2, undelivered: 0 });
    expect((await makeOrders().sendDueReminders()).sent).toBe(0);
    expect(pushes).toHaveLength(2);
  });

  it('reminds on the Tunis date, not the UTC date', async () => {
    seedOrder('a', { expectedDate: '2026-11-11' });
    now = at('2026-11-10T23:30:00Z'); // 00:30 on the 11th in Tunis, still the 10th in UTC
    expect((await makeOrders().sendDueReminders()).date).toBe('2026-11-11');
  });
});

describe('Tunis time helpers', () => {
  it('business date and reminder time', () => {
    expect(businessDateAt(at('2026-11-10T22:59:59Z'))).toBe('2026-11-10');
    expect(businessDateAt(at('2026-11-10T23:00:00Z'))).toBe('2026-11-11');
    expect(isPastReminderTime(at('2026-11-11T06:59:59Z'))).toBe(false);
    expect(isPastReminderTime(at('2026-11-11T07:00:00Z'))).toBe(true);
  });
  it('next 08:00 run', () => {
    expect(new Date(nextRunAfter(at('2026-11-11T02:00:00Z'))).toISOString()).toBe('2026-11-11T07:00:00.000Z');
    expect(new Date(nextRunAfter(at('2026-11-11T07:00:00Z'))).toISOString()).toBe('2026-11-12T07:00:00.000Z');
    expect(new Date(nextRunAfter(at('2026-11-11T20:00:00Z'))).toISOString()).toBe('2026-11-12T07:00:00.000Z');
    // across a month and a year end
    expect(new Date(nextRunAfter(at('2026-12-31T12:00:00Z'))).toISOString()).toBe('2027-01-01T07:00:00.000Z');
  });
  it('is DST-aware for zones that have it (08:00 Paris is 07:00 UTC in winter, 06:00 UTC in summer)', () => {
    const opt = { timeZone: 'Europe/Paris' };
    expect(new Date(nextRunAfter(at('2026-01-10T00:00:00Z'), opt)).toISOString()).toBe('2026-01-10T07:00:00.000Z');
    expect(new Date(nextRunAfter(at('2026-07-10T00:00:00Z'), opt)).toISOString()).toBe('2026-07-10T06:00:00.000Z');
  });
});

describe('startDailyReminders', () => {
  const harness = (startAt, run) => {
    let t = startAt; const timers = []; const calls = [];
    const stop = startDailyReminders({
      run: async () => { calls.push(t); return run?.(calls.length) ?? { undelivered: 0 }; },
      now: () => t,
      setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
      clearTimer: () => {},
    });
    const tick = async (to) => { t = to; const h = timers[timers.length - 1]; await h.fn(); };
    return { calls, timers, tick, stop, setNow: (v) => { t = v; } };
  };

  it('does nothing before 08:00, runs once when the time comes, then not again the same day', async () => {
    const h = harness(at('2026-11-11T05:00:00Z'));
    expect(h.calls).toHaveLength(0);
    expect(h.timers.at(-1).ms).toBe(10 * 60_000); // wakes at most every 10 minutes
    await h.tick(at('2026-11-11T06:55:00Z'));
    expect(h.calls).toHaveLength(0);
    expect(h.timers.at(-1).ms).toBe(5 * 60_000); // lands exactly on 08:00 Tunis
    await h.tick(at('2026-11-11T07:00:00Z'));
    expect(h.calls).toHaveLength(1);
    await h.tick(at('2026-11-11T07:10:00Z'));
    await h.tick(at('2026-11-11T15:00:00Z'));
    expect(h.calls).toHaveLength(1);
    await h.tick(at('2026-11-12T07:00:00Z')); // next day
    expect(h.calls).toHaveLength(2);
  });

  it('catches up immediately when the backend starts after 08:00', async () => {
    const h = harness(at('2026-11-11T09:30:00Z'));
    await Promise.resolve();
    expect(h.calls).toHaveLength(1);
  });

  it('retries while reminders are undelivered, up to 6 attempts a day', async () => {
    const h = harness(at('2026-11-11T07:00:00Z'), () => ({ undelivered: 1 }));
    await Promise.resolve();
    for (let i = 1; i <= 10; i += 1) await h.tick(at('2026-11-11T07:00:00Z') + i * 600_000);
    expect(h.calls).toHaveLength(6);
  });

  it('keeps going after a failed run', async () => {
    let n = 0;
    const h = harness(at('2026-11-11T07:00:00Z'), () => { n += 1; if (n === 1) throw new Error('boom'); return { undelivered: 0 }; });
    await Promise.resolve();
    await h.tick(at('2026-11-11T07:10:00Z'));
    await h.tick(at('2026-11-11T07:20:00Z'));
    expect(h.calls).toHaveLength(2);
  });
});

describe('notifier: expected-today push', () => {
  const order = { id: 'o1', number: 'TY-O-000001', customerName: 'سالم', expectedDate: TODAY, lines: [{ productName: 'تمر', qty: 1 }, { productName: 'عسل', qty: 2 }] };
  const tok = (s) => s.padEnd(24, 'x');

  it('has its own texts per language', () => {
    expect(expectedTodayMessage('fr', order)).toEqual({ title: 'Commande client prévue aujourd’hui', body: 'سالم : تمر +1 (TY-O-000001)' });
    expect(expectedTodayMessage('ar', order)).toEqual({ title: 'موعد طلب زبون اليوم', body: 'سالم: تمر +1 (TY-O-000001)' });
  });

  it('uses its own type and tray tag, and a failing language group does not hide the other one', async () => {
    const calls = [];
    const messaging = {
      sendEachForMulticast: async (m) => {
        if (m.notification.title.startsWith('Commande')) throw new Error('fcm hiccup');
        calls.push(m); return { responses: m.tokens.map(() => ({ success: true })) };
      },
    };
    const n = createNotifier({ db, messaging, now: () => now });
    await n.registerDevice('u1', { token: tok('ar-device'), lang: 'ar' });
    await n.registerDevice('u1', { token: tok('fr-device'), lang: 'fr' });
    const r = await n.orderExpectedToday(order);
    expect(r.sent).toBe(1);
    expect(calls[0]).toMatchObject({
      data: { type: 'customer_order_expected_today', orderId: 'o1', expectedDate: TODAY },
      android: { priority: 'high', notification: { channelId: 'customer_orders', tag: 'o1:expected' } },
    });
  });

  it('the availability push is unchanged and still throws on a send failure', async () => {
    const messaging = { sendEachForMulticast: async () => { throw new Error('down'); } };
    const n = createNotifier({ db, messaging, now: () => now });
    await n.registerDevice('u1', { token: tok('ar-device'), lang: 'ar' });
    await expect(n.orderAvailable(order)).rejects.toThrow('down');
  });
});
