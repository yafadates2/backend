import { describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { SalesError } from '../src/salesMath.js';

const logger = pino({ level: 'silent' });
const users = { member: { uid: 'u1', member: true }, stranger: { uid: 'u2' } };
const verifyToken = async (t) => { if (!users[t]) throw new Error('bad'); return users[t]; };
const membership = { claim: async () => ({ role: 'member' }), createInvite: async () => ({}) };
const expenses = {
  createExpense: async (uid, d) => {
    if (d.expenseId === 'dup-0000-0001') return { id: d.expenseId, number: 'TY-E-000001', duplicate: true };
    if (d.expenseId === 'cat-0000-0001') throw new SalesError('expense_category_archived', 409);
    if (d.expenseId === 'boom-0000-001') throw new Error('db-detail');
    return { id: d.expenseId, number: 'TY-E-000001', duplicate: false };
  },
  updateExpense: async (uid, id) => {
    if (id === 'arch-0000-0001') throw new SalesError('expense_archived', 409);
    return { id, number: 'TY-E-000001', changed: true };
  },
  setArchived: async (uid, id, archived) => ({ id, isArchived: archived, duplicate: false }),
};
const app = () => createApp({ verifyToken, imageStore: {}, membership, logger, expenses });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const body = (over = {}) => ({
  expenseId: 'exp-0000-0001', title: 'كراء', amount: 1000, categoryId: 'rent', businessDate: '2026-11-03', ...over,
});

describe('POST /expenses', () => {
  it('requires a bearer token and the member claim', async () => {
    expect((await request(app()).post('/expenses').send(body())).status).toBe(401);
    expect((await request(app()).post('/expenses').set(auth('stranger')).send(body())).status).toBe(403);
  });
  it('creates (201) and answers a retry with 200', async () => {
    const ok = await request(app()).post('/expenses').set(auth('member')).send(body());
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ number: 'TY-E-000001', duplicate: false });
    const dup = await request(app()).post('/expenses').set(auth('member')).send(body({ expenseId: 'dup-0000-0001' }));
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
  });
  it('rejects invalid bodies (400)', async () => {
    for (const over of [{ amount: 0 }, { amount: 1.5 }, { amount: -5 }, { title: '' }, { title: '   ' }, { businessDate: '3/11' },
      { expenseId: 'x' }, { extra: 1 }, { attachmentKey: 5 }]) {
      const r = await request(app()).post('/expenses').set(auth('member')).send(body(over));
      expect(r.status).toBe(400);
    }
  });
  it('maps business errors to their code and hides unexpected ones', async () => {
    const e = await request(app()).post('/expenses').set(auth('member')).send(body({ expenseId: 'cat-0000-0001' }));
    expect(e.status).toBe(409);
    expect(e.body.code).toBe('expense_category_archived');
    const boom = await request(app()).post('/expenses').set(auth('member')).send(body({ expenseId: 'boom-0000-001' }));
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toContain('db-detail');
  });
});

describe('update and archive', () => {
  const upd = { title: 't', amount: 5, categoryId: 'c', businessDate: '2026-11-03' };
  it('updates an expense', async () => {
    const r = await request(app()).post('/expenses/exp-0000-0001/update').set(auth('member')).send(upd);
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(true);
    expect((await request(app()).post('/expenses/arch-0000-0001/update').set(auth('member')).send(upd)).body.code).toBe('expense_archived');
  });
  it('update refuses an expenseId in the body and a bad path id', async () => {
    expect((await request(app()).post('/expenses/exp-0000-0001/update').set(auth('member')).send({ ...upd, expenseId: 'exp-0000-0001' })).status).toBe(400);
    expect((await request(app()).post('/expenses/x/update').set(auth('member')).send(upd)).status).toBe(400);
  });
  it('archives and restores', async () => {
    const a = await request(app()).post('/expenses/exp-0000-0001/archive').set(auth('member')).send({ archived: true });
    expect(a.body).toMatchObject({ isArchived: true });
    expect((await request(app()).post('/expenses/exp-0000-0001/archive').set(auth('member')).send({ archived: 'yes' })).status).toBe(400);
    expect((await request(app()).post('/expenses/exp-0000-0001/archive').send({ archived: true })).status).toBe(401);
  });
});
