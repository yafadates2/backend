import { describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { SalesError } from '../src/salesMath.js';

const logger = pino({ level: 'silent' });
const users = { member: { uid: 'u1', member: true }, stranger: { uid: 'u2' } };
const verifyToken = async (t) => { if (!users[t]) throw new Error('bad'); return users[t]; };
const membership = { claim: async () => ({ role: 'member' }), createInvite: async () => ({}) };
const purchases = {
  createPurchase: async (uid, d) => {
    if (d.purchaseId === 'dup-0000-0001') return { id: d.purchaseId, duplicate: true };
    if (d.purchaseId === 'sold-0000-001') throw new SalesError('supplier_archived', 409);
    if (d.purchaseId === 'boom-0000-001') throw new Error('db-detail');
    return { id: d.purchaseId, number: 'TY-P-000001', duplicate: false };
  },
  voidPurchase: async (uid, id) => {
    if (id === 'sold-0000-0001') throw new SalesError('stock_already_sold', 409);
    return { id, status: 'voided', duplicate: false };
  },
  paySupplier: async (uid, d) => ({ id: d.paymentId, number: 'TY-S-000001', amount: d.amount, duplicate: false }),
};
const app = () => createApp({ verifyToken, imageStore: {}, membership, logger, purchases });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const body = (over = {}) => ({
  purchaseId: 'buy-0000-0001', supplierId: 's1', businessDate: '2026-11-03',
  lines: [{ productId: 'p1', qty: 1, unitCost: 1000 }], cashPaid: 1000, ...over,
});

describe('purchase routes', () => {
  it('require auth and membership, and do not leak onto /auth/claim', async () => {
    expect((await request(app()).post('/purchases').send(body())).status).toBe(401);
    const r = await request(app()).post('/purchases').set(auth('stranger')).send(body());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_member');
    expect((await request(app()).post('/auth/claim').set(auth('stranger')).send({})).status).toBe(200);
  });
  it('creates (201), duplicate (200), maps business errors, hides unexpected ones', async () => {
    expect((await request(app()).post('/purchases').set(auth('member')).send(body())).status).toBe(201);
    expect((await request(app()).post('/purchases').set(auth('member')).send(body({ purchaseId: 'dup-0000-0001' }))).status).toBe(200);
    const a = await request(app()).post('/purchases').set(auth('member')).send(body({ purchaseId: 'sold-0000-001' }));
    expect([a.status, a.body.code]).toEqual([409, 'supplier_archived']);
    const b = await request(app()).post('/purchases').set(auth('member')).send(body({ purchaseId: 'boom-0000-001' }));
    expect(b.status).toBe(500);
    expect(JSON.stringify(b.body)).not.toContain('db-detail');
  });
  it('rejects bad input (decimals, extra keys, empty, 51 lines, negative cost, missing supplier)', async () => {
    const bad = [
      body({ cashPaid: 1.5 }), { ...body(), extra: 1 }, body({ lines: [] }),
      body({ lines: Array.from({ length: 51 }, (_, i) => ({ productId: `p${i}`, qty: 1, unitCost: 1 })) }),
      body({ lines: [{ productId: 'p1', qty: 1, unitCost: -1 }] }), body({ supplierId: undefined }),
      body({ extraCosts: -5 }), body({ purchaseId: 'x' }),
    ];
    for (const b of bad) {
      const r = await request(app()).post('/purchases').set(auth('member')).send(b);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_request');
    }
  });
  it('void and supplier payment work; void blocked maps to 409', async () => {
    const v = await request(app()).post('/purchases/buy-0000-0001/void').set(auth('member')).send({ businessDate: '2026-11-03' });
    expect([v.status, v.body.status]).toEqual([200, 'voided']);
    const blocked = await request(app()).post('/purchases/sold-0000-0001/void').set(auth('member')).send({ businessDate: '2026-11-03' });
    expect([blocked.status, blocked.body.code]).toEqual([409, 'stock_already_sold']);
    const p = await request(app()).post('/payments/supplier').set(auth('member'))
      .send({ paymentId: 'spay-0000-0001', supplierId: 's1', amount: 500, businessDate: '2026-11-03' });
    expect([p.status, p.body.number]).toEqual([201, 'TY-S-000001']);
  });
});
