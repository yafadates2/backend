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
const sales = {
  createSale: async (uid, d) => { calls.push(['create', uid, d]); if (d.saleId === 'dup-0000-0001') return { id: d.saleId, duplicate: true }; if (d.saleId === 'stk-0000-0001') throw new SalesError('insufficient_stock', 409); if (d.saleId === 'boom-0000-001') throw new Error('db-detail'); return { id: d.saleId, number: 'TY-000001', duplicate: false }; },
  voidSale: async (uid, id) => ({ id, status: 'voided', duplicate: false }),
  receivePayment: async (uid, d) => ({ id: d.paymentId, number: 'TY-R-000001', amount: d.amount, duplicate: false }),
};
const app = () => createApp({ verifyToken, imageStore: {}, membership, logger, sales });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const body = (over = {}) => ({ saleId: 'sale-0000-0001', businessDate: '2026-11-03', lines: [{ productId: 'p1', qty: 1 }], discount: 0, cashPaid: 1000, ...over });

describe('sales routes', () => {
  it('require auth and membership', async () => {
    expect((await request(app()).post('/sales').send(body())).status).toBe(401);
    const r = await request(app()).post('/sales').set(auth('stranger')).send(body());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_member');
  });
  it('the sales guards do not leak onto other routes (non-members can still claim)', async () => {
    expect((await request(app()).post('/auth/claim').set(auth('stranger')).send({})).status).toBe(200);
  });
  it('creates a sale (201) and returns 200 for a duplicate submit', async () => {
    expect((await request(app()).post('/sales').set(auth('member')).send(body())).status).toBe(201);
    expect((await request(app()).post('/sales').set(auth('member')).send(body({ saleId: 'dup-0000-0001' }))).status).toBe(200);
  });
  it('rejects bad input with invalid_request (decimals, extra keys, empty cart, 51 lines)', async () => {
    const bad = [
      body({ cashPaid: 10.5 }), { ...body(), extra: 1 }, body({ lines: [] }),
      body({ lines: Array.from({ length: 51 }, (_, i) => ({ productId: `p${i}`, qty: 1 })) }),
      body({ saleId: 'x' }), body({ businessDate: 'today' }),
    ];
    for (const b of bad) {
      const r = await request(app()).post('/sales').set(auth('member')).send(b);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('invalid_request');
    }
  });
  it('maps business errors to their code and hides unexpected ones', async () => {
    const a = await request(app()).post('/sales').set(auth('member')).send(body({ saleId: 'stk-0000-0001' }));
    expect(a.status).toBe(409);
    expect(a.body.code).toBe('insufficient_stock');
    const b = await request(app()).post('/sales').set(auth('member')).send(body({ saleId: 'boom-0000-001' }));
    expect(b.status).toBe(500);
    expect(JSON.stringify(b.body)).not.toContain('db-detail');
  });
  it('void and customer payment work', async () => {
    const v = await request(app()).post('/sales/sale-0000-0001/void').set(auth('member')).send({ businessDate: '2026-11-03' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('voided');
    const p = await request(app()).post('/payments/customer').set(auth('member'))
      .send({ paymentId: 'pay-0000-0001', clientId: 'k1', amount: 500, businessDate: '2026-11-03' });
    expect(p.status).toBe(201);
    expect((await request(app()).post('/payments/customer').set(auth('member')).send({ paymentId: 'pay-0000-0001', clientId: 'k1', amount: 0, businessDate: '2026-11-03' })).status).toBe(400);
  });
});
