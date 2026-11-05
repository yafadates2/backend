import { describe, it, expect } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { createPdfService } from '../src/pdf/service.js';
import { PdfDataError } from '../src/pdf/data.js';

const logger = pino({ level: 'silent' });
const users = { member: { uid: 'u1', member: true }, stranger: { uid: 'u2' } };
const verifyToken = async (t) => { if (!users[t]) throw new Error('bad'); return users[t]; };
const membership = { claim: async () => ({ role: 'member' }), createInvite: async () => ({}) };
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const fakeBytes = Buffer.from('%PDF-1.7 fake');
const calls = [];
const shop = { name: 'x', phone: '', address: '', logoDataUri: null, decimals: 3, symbol: '' };
const data = {
  shop: async () => shop,
  saleBill: async (id) => {
    if (id === 'missing') throw new PdfDataError('not_found', 404);
    return { kind: 'bill', variant: 'sale', number: 'TY-000001', dateText: '', party: null, lines: [], subtotal: 0, discount: 0, extraCosts: 0, total: 0, paid: 0, remaining: 0, methodKey: 'cash', note: '', voided: null };
  },
  statement: async () => ({ kind: 'statement', variant: 'client', party: null, fromText: '', toText: '', opening: 0, closing: 0, balanceNow: 0, rows: [], generatedText: '' }),
  profitReport: async () => ({ kind: 'profitReport', fromText: '', toText: '', days: [], totals: { gross: 0, voided: 0, net: 0, cogs: 0, discounts: 0, grossProfit: 0, expenses: 0, netProfit: 0, cashIn: 0, credit: 0, purchases: 0, supplierPaid: 0 }, generatedText: '' }),
  expenseReport: async () => ({ kind: 'expenseReport', fromText: '', toText: '', categoryName: null, rows: [], byCategory: [], total: 0, count: 0, truncated: false, generatedText: '' }),
};
const renderer = { render: async (html, o) => { calls.push(o); return fakeBytes; } };
const pdf = createPdfService({ data, renderer, fonts: {}, logger });
const app = () => createApp({ verifyToken, imageStore: {}, membership, logger, pdf });

describe('GET /pdf/*', () => {
  it('requires a bearer token and the member claim', async () => {
    expect((await request(app()).get('/pdf/sales/abc')).status).toBe(401);
    expect((await request(app()).get('/pdf/sales/abc').set(auth('stranger'))).status).toBe(403);
  });
  it('returns a non-cacheable inline PDF named after the document', async () => {
    const r = await request(app()).get('/pdf/sales/abc?lang=fr&format=thermal').set(auth('member'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-disposition']).toBe('inline; filename="TY-000001.pdf"');
    expect(calls.at(-1)).toEqual({ format: 'thermal' });
  });
  it('maps data errors and validates input', async () => {
    expect((await request(app()).get('/pdf/sales/missing').set(auth('member'))).body).toEqual({ error: 'not_found', code: 'not_found' });
    expect((await request(app()).get('/pdf/sales/abc?format=letter').set(auth('member'))).status).toBe(400);
    expect((await request(app()).get('/pdf/sales/abc?lang=en').set(auth('member'))).status).toBe(400);
    expect((await request(app()).get('/pdf/sales/abc?extra=1').set(auth('member'))).status).toBe(400);
    expect((await request(app()).get('/pdf/sales/a.b').set(auth('member'))).status).toBe(400);
  });
  it('statements and reports need a period and are A4 only', async () => {
    expect((await request(app()).get('/pdf/clients/k1/statement').set(auth('member'))).status).toBe(400);
    const ok = await request(app()).get('/pdf/clients/k1/statement?from=2026-11-01&to=2026-11-30').set(auth('member'));
    expect(ok.status).toBe(200);
    const thermal = await request(app()).get('/pdf/reports/expenses?from=2026-11-01&to=2026-11-30&format=thermal').set(auth('member'));
    expect(thermal.status).toBe(400);
    expect(thermal.body.code).toBe('format_not_supported');
    expect((await request(app()).get('/pdf/reports/expenses?from=2026-11-01&to=2026-11-30&categoryId=rent').set(auth('member'))).status).toBe(200);
    expect((await request(app()).get('/pdf/reports/profit?from=2026-11-01&to=2026-11-30').set(auth('member'))).status).toBe(200);
    expect((await request(app()).get('/pdf/reports/profit?from=2026-11-01&to=2026-11-30&format=thermal').set(auth('member'))).body.code).toBe('format_not_supported');
    expect((await request(app()).get('/pdf/reports/profit').set(auth('member'))).status).toBe(400);
  });
  it('hides internal errors', async () => {
    const boom = createPdfService({ data: { ...data, saleBill: async () => { throw new Error('secret-db-detail'); } }, renderer, fonts: {}, logger });
    const r = await request(createApp({ verifyToken, imageStore: {}, membership, logger, pdf: boom })).get('/pdf/sales/abc').set(auth('member'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret');
  });
});
