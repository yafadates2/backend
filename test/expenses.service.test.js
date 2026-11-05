import { describe, it, expect, beforeEach } from 'vitest';
import { createExpensesService } from '../src/expenses.js';
import { reconcile } from '../src/reconcile.js';
import { createFakeDb, fieldValue } from './helpers/fakeFirestore.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const D1 = '2026-11-03';
const D0 = '2026-11-01';
const UID = 'u1';
const KEY = 'expenses/0a1b2c3d-0000-4000-8000-0123456789ab.webp';
const KEY2 = 'expenses/0a1b2c3d-0000-4000-8000-0123456789ac.webp';

let db;
let svc;
const code = async (p) => { try { await p; } catch (e) { return e.code ?? `other:${e.message}`; } return null; };

beforeEach(() => {
  db = createFakeDb();
  svc = createExpensesService({ db, fieldValue, now: () => NOW });
  db.seed('shop_settings/main', { invoicePrefix: 'TY' });
  db.seed('expense_categories/rent', { name: 'الكراء', isArchived: false });
  db.seed('expense_categories/power', { name: 'الكهرباء', isArchived: false });
  db.seed('expense_categories/old', { name: 'قديم', isArchived: true });
});

const exp = (over = {}) => ({
  expenseId: 'exp-0001-aaaa', title: 'كراء نوفمبر', amount: 450000, categoryId: 'rent',
  businessDate: D1, description: 'نقدًا', attachmentKey: null, ...over,
});

describe('createExpense', () => {
  it('stores the expense, numbers it and updates the day stats', async () => {
    const r = await svc.createExpense(UID, exp({ attachmentKey: KEY }));
    expect(r).toEqual({ id: 'exp-0001-aaaa', number: 'TY-E-000001', duplicate: false });
    expect(db.get('expenses/exp-0001-aaaa')).toMatchObject({
      title: 'كراء نوفمبر', amount: 450000, method: 'cash', categoryId: 'rent', categoryName: 'الكراء',
      businessDate: D1, attachmentKey: KEY, isArchived: false, createdBy: UID,
    });
    expect(db.get('counters/expenses')).toEqual({ value: 1 });
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 1, expensesTotal: 450000 });
  });

  it('numbers sequentially and sums per day', async () => {
    await svc.createExpense(UID, exp());
    const r = await svc.createExpense(UID, exp({ expenseId: 'exp-0002-bbbb', amount: 1500, categoryId: 'power' }));
    expect(r.number).toBe('TY-E-000002');
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 2, expensesTotal: 451500 });
  });

  it('is idempotent and detects an id reused with other content', async () => {
    await svc.createExpense(UID, exp());
    const again = await svc.createExpense(UID, exp());
    expect(again).toMatchObject({ duplicate: true, number: 'TY-E-000001' });
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 1, expensesTotal: 450000 });
    expect(db.get('counters/expenses')).toEqual({ value: 1 });
    expect(await code(svc.createExpense(UID, exp({ amount: 1 })))).toBe('idempotency_conflict');
  });

  it('validates category, date and attachment key; commits nothing on failure', async () => {
    expect(await code(svc.createExpense(UID, exp({ categoryId: 'nope' })))).toBe('expense_category_not_found');
    expect(await code(svc.createExpense(UID, exp({ categoryId: 'old' })))).toBe('expense_category_archived');
    expect(await code(svc.createExpense(UID, exp({ businessDate: '2024-01-01' })))).toBe('invalid_business_date');
    expect(await code(svc.createExpense(UID, exp({ attachmentKey: 'products/x.webp' })))).toBe('invalid_request');
    expect(await code(svc.createExpense(UID, exp({ attachmentKey: KEY.replace('expenses', 'products') })))).toBe('invalid_request');
    expect(db.get('expenses/exp-0001-aaaa')).toBeUndefined();
    expect(db.get('counters/expenses')).toBeUndefined();
    expect(db.get(`daily_stats/${D1}`)).toBeUndefined();
  });

  it('accepts a past date', async () => {
    await svc.createExpense(UID, exp({ businessDate: D0 }));
    expect(db.get(`daily_stats/${D0}`)).toMatchObject({ expensesCount: 1, expensesTotal: 450000 });
  });
});

describe('updateExpense', () => {
  beforeEach(async () => { await svc.createExpense(UID, exp()); });
  const upd = (over = {}) => ({ title: 'كراء', amount: 400000, categoryId: 'rent', businessDate: D1, description: '', attachmentKey: null, ...over });

  it('same-day amount change moves the total by the difference', async () => {
    const r = await svc.updateExpense(UID, 'exp-0001-aaaa', upd());
    expect(r).toMatchObject({ number: 'TY-E-000001', changed: true });
    expect(db.get('expenses/exp-0001-aaaa')).toMatchObject({ title: 'كراء', amount: 400000, updatedBy: UID });
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 1, expensesTotal: 400000 });
  });

  it('changing the date moves the amount to the other day', async () => {
    await svc.updateExpense(UID, 'exp-0001-aaaa', upd({ amount: 450000, businessDate: D0 }));
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 0, expensesTotal: 0 });
    expect(db.get(`daily_stats/${D0}`)).toMatchObject({ expensesCount: 1, expensesTotal: 450000 });
  });

  it('category change refreshes the name snapshot; archived target category is refused', async () => {
    await svc.updateExpense(UID, 'exp-0001-aaaa', upd({ amount: 450000, categoryId: 'power' }));
    expect(db.get('expenses/exp-0001-aaaa')).toMatchObject({ categoryId: 'power', categoryName: 'الكهرباء' });
    expect(await code(svc.updateExpense(UID, 'exp-0001-aaaa', upd({ categoryId: 'old' })))).toBe('expense_category_archived');
  });

  it('an identical edit is a no-op (safe retry)', async () => {
    await svc.updateExpense(UID, 'exp-0001-aaaa', upd());
    const again = await svc.updateExpense(UID, 'exp-0001-aaaa', upd());
    expect(again.changed).toBe(false);
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 1, expensesTotal: 400000 });
  });

  it('replaces the attachment key', async () => {
    await svc.updateExpense(UID, 'exp-0001-aaaa', upd({ amount: 450000, title: 'كراء نوفمبر', description: 'نقدًا', attachmentKey: KEY2 }));
    expect(db.get('expenses/exp-0001-aaaa').attachmentKey).toBe(KEY2);
  });

  it('missing and archived expenses cannot be edited', async () => {
    expect(await code(svc.updateExpense(UID, 'nope-0000-0001', upd()))).toBe('expense_not_found');
    await svc.setArchived(UID, 'exp-0001-aaaa', true);
    expect(await code(svc.updateExpense(UID, 'exp-0001-aaaa', upd()))).toBe('expense_archived');
  });
});

describe('setArchived', () => {
  beforeEach(async () => { await svc.createExpense(UID, exp()); });

  it('archive removes it from the day totals, restore adds it back', async () => {
    const a = await svc.setArchived(UID, 'exp-0001-aaaa', true);
    expect(a).toMatchObject({ isArchived: true, duplicate: false });
    expect(db.get('expenses/exp-0001-aaaa')).toMatchObject({ isArchived: true, archivedBy: UID });
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 0, expensesTotal: 0 });
    await svc.setArchived(UID, 'exp-0001-aaaa', false);
    expect(db.get('expenses/exp-0001-aaaa')).toMatchObject({ isArchived: false, archivedBy: null });
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 1, expensesTotal: 450000 });
  });

  it('repeating the same state does not double-count', async () => {
    await svc.setArchived(UID, 'exp-0001-aaaa', true);
    expect((await svc.setArchived(UID, 'exp-0001-aaaa', true)).duplicate).toBe(true);
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 0, expensesTotal: 0 });
    expect((await svc.setArchived(UID, 'exp-0001-aaaa', false)).duplicate).toBe(false);
    expect((await svc.setArchived(UID, 'exp-0001-aaaa', false)).duplicate).toBe(true);
    expect(db.get(`daily_stats/${D1}`)).toMatchObject({ expensesCount: 1, expensesTotal: 450000 });
  });

  it('unknown expense', async () => {
    expect(await code(svc.setArchived(UID, 'nope-0000-0001', true))).toBe('expense_not_found');
  });
});

describe('reconcile after a mixed history', () => {
  const list = () => [...db.store.entries()]
    .filter(([p]) => p.startsWith('expenses/') || p.startsWith('daily_stats/'))
    .map(([p, d]) => ({ id: p.split('/').pop(), coll: p.split('/')[0], ...d }));
  const run = () => reconcile({
    products: [], movements: [], clients: [], sales: [],
    stats: list().filter((x) => x.coll === 'daily_stats'),
    expenses: list().filter((x) => x.coll === 'expenses'),
  });

  it('create, edit, move date, archive, restore: stats agree with the documents', async () => {
    await svc.createExpense(UID, exp());
    await svc.createExpense(UID, exp({ expenseId: 'exp-0002-bbbb', amount: 900, categoryId: 'power', businessDate: D0 }));
    await svc.updateExpense(UID, 'exp-0001-aaaa', { title: 'x', amount: 1000, categoryId: 'rent', businessDate: D0, description: '', attachmentKey: null });
    await svc.setArchived(UID, 'exp-0002-bbbb', true);
    expect(run()).toEqual([]);
    await svc.setArchived(UID, 'exp-0002-bbbb', false);
    expect(run()).toEqual([]);
  });

  it('detects a tampered stats document', async () => {
    await svc.createExpense(UID, exp());
    db.seed(`daily_stats/${D1}`, { businessDate: D1, expensesCount: 1, expensesTotal: 1 });
    expect(run().map((i) => i.kind)).toContain('daily_stats_expenses');
  });
});
