import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { isValidKey, normalizeImage } from '../src/images.js';
import { findOrphans } from '../src/sweep.js';

const logger = pino({ level: 'silent' });
const users = { member: { uid: 'u1', member: true }, stranger: { uid: 's1' } };
const verifyToken = async (t) => { if (!users[t]) throw new Error('bad'); return users[t]; };
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const KEY = 'products/0b9f6a2e-1c3d-4e5f-8a7b-9c0d1e2f3a4b.webp';

function makeStore() {
  return {
    selfTest: async () => ({ ok: true, ms: 1, presigned: true }),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    signedUrl: vi.fn(async (k) => `https://signed.example/${k}?sig=1`),
  };
}
const make = (store = makeStore(), isReferenced = async () => false) =>
  createApp({ verifyToken, imageStore: store, membership: {}, logger, isReferenced });
const png = (w = 2000, h = 1000) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#a0522d' } }).png().toBuffer();

describe('key validation', () => {
  it('accepts only our own key shape', () => {
    expect(isValidKey(KEY)).toBe(true);
    expect(isValidKey(KEY.replace('products/', 'expenses/'))).toBe(true); // Phase 8 attachment folder
    for (const bad of ['', null, 'products/x.webp', '../products/' + KEY.slice(9), 'other/' + KEY.slice(9),
      KEY + '/..', KEY.replace('.webp', '.png'), 'products/../' + KEY.slice(9)]) {
      expect(isValidKey(bad)).toBe(false);
    }
  });
});

describe('normalizeImage', () => {
  it('re-encodes to WebP no larger than 1024px', async () => {
    const out = await normalizeImage(await png());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1024);
    expect(meta.width).toBe(1024); // aspect ratio kept: 2000x1000 -> 1024x512
    expect(meta.height).toBe(512);
  });
  it('does not enlarge small images', async () => {
    const meta = await sharp(await normalizeImage(await png(200, 100))).metadata();
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });
  it('rejects non-images even when named .png', async () => {
    await expect(normalizeImage(Buffer.from('<?php echo 1; ?>'))).rejects.toMatchObject({ status: 415 });
  });
  it('rejects a truncated image', async () => {
    const b = await png();
    await expect(normalizeImage(b.subarray(0, 40))).rejects.toMatchObject({ status: expect.any(Number) });
  });
});

describe('access control', () => {
  it('401 without token, 403 for signed-in non-members', async () => {
    const app = make();
    expect((await request(app).get('/images/signed').query({ key: KEY })).status).toBe(401);
    for (const call of [
      request(app).get('/images/signed').query({ key: KEY }).set(auth('stranger')),
      request(app).delete(`/images/${KEY}`).set(auth('stranger')),
      request(app).post('/images').set(auth('stranger')).field('kind', 'products'),
      request(app).get('/health/storage').set(auth('stranger')),
    ]) {
      const r = await call;
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('not_member');
    }
  });
});

describe('POST /images', () => {
  it('stores a re-encoded WebP under a fresh key', async () => {
    const store = makeStore();
    const r = await request(make(store)).post('/images').set(auth('member'))
      .field('kind', 'products').attach('file', await png(), 'photo.png');
    expect(r.status).toBe(201);
    expect(isValidKey(r.body.key)).toBe(true);
    expect(r.body.key.startsWith('products/')).toBe(true);
    const [key, body, type] = store.put.mock.calls[0];
    expect(key).toBe(r.body.key);
    expect(type).toBe('image/webp');
    expect((await sharp(body).metadata()).format).toBe('webp');
  });
  it('two uploads never share a key', async () => {
    const app = make();
    const a = await request(app).post('/images').set(auth('member')).field('kind', 'shop').attach('file', await png(50, 50), 'a.png');
    const b = await request(app).post('/images').set(auth('member')).field('kind', 'shop').attach('file', await png(50, 50), 'a.png');
    expect(a.body.key).not.toBe(b.body.key);
  });
  it('400 for unknown kind or missing file', async () => {
    const app = make();
    const r1 = await request(app).post('/images').set(auth('member')).field('kind', 'evil').attach('file', await png(50, 50), 'a.png');
    expect(r1.status).toBe(400);
    expect(r1.body.code).toBe('invalid_kind');
    const r2 = await request(app).post('/images').set(auth('member')).field('kind', 'products');
    expect(r2.status).toBe(400);
  });
  it('415 for a non-image, nothing stored', async () => {
    const store = makeStore();
    const r = await request(make(store)).post('/images').set(auth('member'))
      .field('kind', 'products').attach('file', Buffer.from('hello world'), 'x.png');
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('image_type');
    expect(store.put).not.toHaveBeenCalled();
  });
  it('413 above 5 MB', async () => {
    const r = await request(make()).post('/images').set(auth('member'))
      .field('kind', 'products').attach('file', Buffer.alloc(5 * 1024 * 1024 + 10, 1), 'big.png');
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('image_too_large');
  });
  it('storage failure is a 500 without leaking details', async () => {
    const store = makeStore();
    store.put = vi.fn(async () => { throw new Error('secret-detail'); });
    const r = await request(make(store)).post('/images').set(auth('member'))
      .field('kind', 'products').attach('file', await png(50, 50), 'a.png');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret-detail');
  });
});

describe('DELETE /images/:kind/:name', () => {
  it('deletes an unreferenced image', async () => {
    const store = makeStore();
    const r = await request(make(store, async () => false)).delete(`/images/${KEY}`).set(auth('member'));
    expect(r.status).toBe(200);
    expect(store.delete).toHaveBeenCalledWith(KEY);
  });
  it('refuses (409) while Firestore still references it', async () => {
    const store = makeStore();
    const r = await request(make(store, async () => true)).delete(`/images/${KEY}`).set(auth('member'));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('image_in_use');
    expect(store.delete).not.toHaveBeenCalled();
  });
  it('rejects malformed keys and path tricks', async () => {
    const store = makeStore();
    const app = make(store);
    expect((await request(app).delete('/images/products/not-a-uuid.webp').set(auth('member'))).status).toBe(400);
    expect((await request(app).delete('/images/products/..%2Fshop%2Fx.webp').set(auth('member'))).status).toBe(400);
    expect(store.delete).not.toHaveBeenCalled();
  });
  it('without isReferenced wiring, never deletes', async () => {
    const store = makeStore();
    const app = createApp({ verifyToken, imageStore: store, membership: {}, logger });
    expect((await request(app).delete(`/images/${KEY}`).set(auth('member'))).status).toBe(409);
    expect(store.delete).not.toHaveBeenCalled();
  });
});

describe('GET /images/signed', () => {
  it('returns a short-lived URL for a valid key', async () => {
    const r = await request(make()).get('/images/signed').query({ key: KEY }).set(auth('member'));
    expect(r.status).toBe(200);
    expect(r.body.url).toContain(KEY);
    expect(r.body.expiresAt).toBeGreaterThan(Date.now());
  });
  it('400 for an invalid key', async () => {
    const r = await request(make()).get('/images/signed').query({ key: '../etc/passwd' }).set(auth('member'));
    expect(r.status).toBe(400);
  });
});

describe('sweep: findOrphans', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const old = new Date(now - 48 * 3600e3);
  const fresh = new Date(now - 3600e3);
  const K2 = KEY.replace('0b9f', '1111');
  const K3 = KEY.replace('0b9f', '2222');
  it('keeps referenced, fresh and foreign objects; returns old unreferenced ones', () => {
    const objs = [
      { key: KEY, lastModified: old },                       // referenced
      { key: K2, lastModified: old },                        // orphan
      { key: K3, lastModified: fresh },                      // too new
      { key: 'products/readme.txt', lastModified: old },     // not ours
    ];
    expect(findOrphans(objs, new Set([KEY]), { now }).map((o) => o.key)).toEqual([K2]);
  });
});
