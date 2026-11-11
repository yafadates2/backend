import { describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { SalesError } from '../src/salesMath.js';

const logger = pino({ level: 'silent' });
const users = { member: { uid: 'u1', member: true }, stranger: { uid: 'u2' } };
const verifyToken = async (t) => { if (!users[t]) throw new Error('bad'); return users[t]; };
const membership = { claim: async () => ({ role: 'member' }), createInvite: async () => ({}) };
const calls = [];
const orders = {
  createOrder: async (uid, d) => { calls.push(['create', d]); return d.orderId === 'dup-0000-0001' ? { id: d.orderId, duplicate: true } : { id: d.orderId, status: 'pending', duplicate: false }; },
  updateOrder: async (uid, id, d) => { calls.push(['update', id, d]); return { id }; },
  markNotified: async (uid, id) => { if (id === 'bad-0000-0001') throw new SalesError('invalid_status', 409); return { id, status: 'notified' }; },
  completeOrder: async (uid, id, d) => { calls.push(['complete', id, d]); if (id === 'stk-0000-0001') throw new SalesError('insufficient_stock', 409); return { id, status: 'completed', duplicate: false }; },
  cancelOrder: async (uid, id, d) => ({ id, status: 'cancelled', reason: d.reason }),
  checkProducts: async (ids) => { calls.push(['checkProducts', ids]); return { checked: 1 }; },
  checkAll: async () => { calls.push(['checkAll']); return { checked: 5 }; },
};
const notifier = { registerDevice: async (uid, d) => { calls.push(['register', uid, d]); return { registered: true }; }, unregisterDevice: async () => ({ unregistered: true }) };
const app = () => createApp({ verifyToken, imageStore: {}, membership, logger, orders, notifier });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const body = (over = {}) => ({ orderId: 'order-0000-0001', customerName: 'سالم', customerPhone: '98123456', lines: [{ productId: 'p1', qty: 2 }], expectedDate: null, ...over });
const post = (path, t = 'member') => request(app()).post(path).set(auth(t));

describe('customer order routes', () => {
  it('require auth and membership', async () => {
    expect((await request(app()).post('/customer-orders').send(body())).status).toBe(401);
    const r = await post('/customer-orders', 'stranger').send(body());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_member');
  });
  it('creates (201) and answers a duplicate submit with 200', async () => {
    expect((await post('/customer-orders').send(body())).status).toBe(201);
    expect((await post('/customer-orders').send(body({ orderId: 'dup-0000-0001' }))).status).toBe(200);
  });
  it('rejects bad input: missing phone/name, bad phone, decimals, extra keys, empty or 51 lines, bad date', async () => {
    const bad = [
      body({ customerPhone: '' }), body({ customerName: '  ' }), body({ customerPhone: '12ab' }),
      body({ lines: [{ productId: 'p1', qty: 1.5 }] }), { ...body(), extra: 1 }, body({ lines: [] }),
      body({ lines: Array.from({ length: 51 }, (_, i) => ({ productId: `p${i}`, qty: 1 })) }),
      body({ orderId: 'x' }), body({ expectedDate: 'tomorrow' }),
    ];
    for (const b of bad) {
      const r = await post('/customer-orders').send(b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.code).toBe('invalid_request');
    }
  });
  it('maps service errors to stable codes and hides internals', async () => {
    const r = await post('/customer-orders/stk-0000-0001/complete').send({ businessDate: '2026-11-10' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('insufficient_stock');
    expect((await post('/customer-orders/bad-0000-0001/notified').send({})).body.code).toBe('invalid_status');
  });
  it('complete needs a date; cancel/patch validate', async () => {
    expect((await post('/customer-orders/order-0000-0001/complete').send({})).status).toBe(400);
    expect((await post('/customer-orders/order-0000-0001/cancel').send({ reason: 'x' })).status).toBe(200);
    const p = await request(app()).patch('/customer-orders/order-0000-0001').set(auth('member')).send({ expectedDate: null, notes: 'ن' });
    expect(p.status).toBe(200);
    expect((await request(app()).patch('/customer-orders/order-0000-0001').set(auth('member')).send({ lines: [] })).status).toBe(400);
    expect((await post('/customer-orders/x/cancel').send({})).status).toBe(400);
  });
  it('check-availability: with ids targets those products, without ids checks everything', async () => {
    calls.length = 0;
    await post('/customer-orders/check-availability').send({ productIds: ['p1', 'p2'] });
    await post('/customer-orders/check-availability').send({});
    expect(calls).toEqual([['checkProducts', ['p1', 'p2']], ['checkAll']]);
  });
  it('registers and removes push devices', async () => {
    const token = 'a'.repeat(40);
    expect((await request(app()).put('/devices').set(auth('member')).send({ token, lang: 'fr' })).status).toBe(200);
    expect((await request(app()).put('/devices').set(auth('member')).send({ token: 'short' })).status).toBe(400);
    expect((await post('/devices/unregister').send({ token })).status).toBe(200);
  });
});
