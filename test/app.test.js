import { describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { MembershipError, generateCode, hashCode } from '../src/membership.js';

const logger = pino({ level: 'silent' });
const okStore = { selfTest: async () => ({ ok: true, ms: 5 }) };
const badStore = { selfTest: async () => { throw new Error('secret-detail'); } };
const users = {
  good: { uid: 'u1', email: 'a@b.c', member: true },
  owner: { uid: 'o1', email: 'o@b.c', member: true, owner: true },
};
const verifyToken = async (t) => {
  if (!users[t]) throw new Error('bad token');
  return users[t];
};
const membership = {
  claim: async (uid, code) => {
    if (code === 'BAD') throw new MembershipError('Invalid invite code', 403, 'invite_invalid');
    if (code === 'BOOM') throw new Error('db-detail');
    return { role: 'member' };
  },
  createInvite: async () => ({ code: 'ABCDEFGHJK', expiresAt: 123 }),
};
const make = (imageStore = okStore) => createApp({ verifyToken, imageStore, membership, logger });
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('API basics', () => {
  it('health is public', async () => {
    const r = await request(make()).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });
  it('rejects missing token', async () => {
    expect((await request(make()).get('/me')).status).toBe(401);
  });
  it('rejects invalid token', async () => {
    expect((await request(make()).get('/me').set(auth('nope'))).status).toBe(401);
  });
  it('returns the user for a valid token', async () => {
    const r = await request(make()).get('/me').set(auth('good'));
    expect(r.status).toBe(200);
    expect(r.body.uid).toBe('u1');
  });
  it('storage check requires auth', async () => {
    expect((await request(make()).get('/health/storage')).status).toBe(401);
  });
  it('storage check succeeds', async () => {
    const r = await request(make()).get('/health/storage').set(auth('good'));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
  it('storage failure returns 502 without leaking details', async () => {
    const r = await request(make(badStore)).get('/health/storage').set(auth('good'));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('secret-detail');
  });
  it('unknown route is 404', async () => {
    expect((await request(make()).get('/nope')).status).toBe(404);
  });
});

describe('membership routes', () => {
  it('claim requires auth', async () => {
    expect((await request(make()).post('/auth/claim').send({})).status).toBe(401);
  });
  it('claim succeeds', async () => {
    const r = await request(make()).post('/auth/claim').set(auth('good')).send({ inviteCode: 'GOOD' });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('member');
  });
  it('claim maps MembershipError to its status', async () => {
    const r = await request(make()).post('/auth/claim').set(auth('good')).send({ inviteCode: 'BAD' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Invalid invite code');
    expect(r.body.code).toBe('invite_invalid');
  });
  it('claim hides unexpected errors', async () => {
    const r = await request(make()).post('/auth/claim').set(auth('good')).send({ inviteCode: 'BOOM' });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('db-detail');
  });
  it('ignores a non-string invite code', async () => {
    const r = await request(make()).post('/auth/claim').set(auth('good')).send({ inviteCode: { $gt: '' } });
    expect(r.status).toBe(200);
  });
  it('invites are owner-only', async () => {
    expect((await request(make()).post('/invites')).status).toBe(401);
    expect((await request(make()).post('/invites').set(auth('good'))).status).toBe(403);
    const r = await request(make()).post('/invites').set(auth('owner'));
    expect(r.status).toBe(201);
    expect(r.body.code).toBe('ABCDEFGHJK');
  });
});

describe('invite code helpers', () => {
  it('generates codes from the safe alphabet', () => {
    const c = generateCode();
    expect(c).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    expect(generateCode()).not.toBe(c);
  });
  it('hashing ignores case and whitespace', () => {
    expect(hashCode(' abcd23 ')).toBe(hashCode('ABCD23'));
  });
});
