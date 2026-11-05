import { SalesError, fingerprint, formatNumber } from './salesMath.js';
import { assertExpenseDate, statsDelta } from './expensesMath.js';

// Same shape as images.js `isValidKey`, restricted to the expenses folder (kept local: no image-stack imports here).
const ATTACHMENT_RE = /^expenses\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

/**
 * Expenses (cash only). Committed by the backend, like sales and purchases, so `daily_stats` can never drift from
 * the expense documents. Rules keep `expenses` read-only for apps.
 *
 *  - create: idempotent by id + fingerprint.
 *  - update: the stats move by the DIFFERENCE between the stored and the new values (date, amount), in the same
 *    transaction; repeating the same edit changes nothing. Archived expenses cannot be edited (restore first).
 *  - archive / restore: an archived expense no longer counts in `daily_stats`; restoring adds it back.
 * Nothing is ever deleted.
 */
export function createExpensesService({ db, fieldValue, now = () => Date.now() }) {
  const settingsRef = db.collection('shop_settings').doc('main');
  const counterRef = db.collection('counters').doc('expenses');
  const statsRef = (date) => db.collection('daily_stats').doc(date);
  const categoryRef = (id) => db.collection('expense_categories').doc(id);
  const expenseRef = (id) => db.collection('expenses').doc(id);
  const inc = (n) => fieldValue.increment(n);
  const ts = () => fieldValue.serverTimestamp();
  const int = (v) => (Number.isSafeInteger(v) ? v : 0);

  const checkAttachment = (key) => {
    if (key == null) return;
    if (typeof key !== 'string' || !ATTACHMENT_RE.test(key)) throw new SalesError('invalid_request', 400);
  };

  const writeStats = (tx, delta) => {
    for (const [date, d] of delta) {
      tx.set(statsRef(date), { businessDate: date, expensesCount: inc(d.count), expensesTotal: inc(d.total), updatedAt: ts() }, { merge: true });
    }
  };

  return {
    /** input: {expenseId, title, amount, categoryId, businessDate, description, attachmentKey} */
    async createExpense(uid, input) {
      const { expenseId, title, amount, categoryId, businessDate } = input;
      const description = input.description ?? '';
      const attachmentKey = input.attachmentKey ?? null;
      assertExpenseDate(businessDate, now());
      checkAttachment(attachmentKey);
      const fp = fingerprint({ title, amount, categoryId, businessDate, description, attachmentKey });

      return db.runTransaction(async (tx) => {
        const [exSnap, catSnap, settingsSnap, counterSnap] = await tx.getAll(expenseRef(expenseId), categoryRef(categoryId), settingsRef, counterRef);
        if (exSnap.exists) {
          if (exSnap.get('fingerprint') !== fp) throw new SalesError('idempotency_conflict', 409);
          return { id: exSnap.id, number: exSnap.get('number'), duplicate: true };
        }
        if (!catSnap.exists) throw new SalesError('expense_category_not_found', 404);
        if (catSnap.get('isArchived') === true) throw new SalesError('expense_category_archived', 409);

        const prefix = (settingsSnap.exists && settingsSnap.get('invoicePrefix')) || 'TY';
        const seq = int(counterSnap.get('value')) + 1;
        const number = formatNumber(`${prefix}-E`, seq);

        tx.create(expenseRef(expenseId), {
          number, fingerprint: fp, title, amount, method: 'cash',
          categoryId, categoryName: catSnap.get('name') ?? '', businessDate, description, attachmentKey,
          isArchived: false, createdBy: uid, createdAt: ts(), updatedBy: uid, updatedAt: ts(),
        });
        tx.set(counterRef, { value: seq });
        writeStats(tx, statsDelta(null, { businessDate, amount }));
        return { id: expenseId, number, duplicate: false };
      });
    },

    /** input: {title, amount, categoryId, businessDate, description, attachmentKey}; returns {id, number, changed}. */
    async updateExpense(uid, expenseId, input) {
      const { title, amount, categoryId, businessDate } = input;
      const description = input.description ?? '';
      const attachmentKey = input.attachmentKey ?? null;
      assertExpenseDate(businessDate, now());
      checkAttachment(attachmentKey);

      return db.runTransaction(async (tx) => {
        const [exSnap, catSnap] = await tx.getAll(expenseRef(expenseId), categoryRef(categoryId));
        if (!exSnap.exists) throw new SalesError('expense_not_found', 404);
        if (exSnap.get('isArchived') === true) throw new SalesError('expense_archived', 409);
        const sameCategory = exSnap.get('categoryId') === categoryId;
        if (!catSnap.exists) throw new SalesError('expense_category_not_found', 404);
        if (!sameCategory && catSnap.get('isArchived') === true) throw new SalesError('expense_category_archived', 409);

        const before = { businessDate: exSnap.get('businessDate'), amount: exSnap.get('amount') };
        const unchanged = exSnap.get('title') === title && before.amount === amount && sameCategory
          && before.businessDate === businessDate && (exSnap.get('description') ?? '') === description
          && (exSnap.get('attachmentKey') ?? null) === attachmentKey;
        if (unchanged) return { id: expenseId, number: exSnap.get('number'), changed: false };

        tx.update(expenseRef(expenseId), {
          title, amount, categoryId, categoryName: catSnap.get('name') ?? '', businessDate, description, attachmentKey,
          updatedBy: uid, updatedAt: ts(),
        });
        writeStats(tx, statsDelta(before, { businessDate, amount }));
        return { id: expenseId, number: exSnap.get('number'), changed: true };
      });
    },

    /** archived=true removes the expense from the day's totals; false puts it back. Same state again = no-op. */
    async setArchived(uid, expenseId, archived) {
      return db.runTransaction(async (tx) => {
        const exSnap = await tx.get(expenseRef(expenseId));
        if (!exSnap.exists) throw new SalesError('expense_not_found', 404);
        if ((exSnap.get('isArchived') === true) === archived) {
          return { id: expenseId, number: exSnap.get('number'), isArchived: archived, duplicate: true };
        }
        const e = { businessDate: exSnap.get('businessDate'), amount: exSnap.get('amount') };
        tx.update(expenseRef(expenseId), archived
          ? { isArchived: true, archivedAt: ts(), archivedBy: uid, updatedAt: ts(), updatedBy: uid }
          : { isArchived: false, archivedAt: null, archivedBy: null, updatedAt: ts(), updatedBy: uid });
        writeStats(tx, archived ? statsDelta(e, null) : statsDelta(null, e));
        return { id: expenseId, number: exSnap.get('number'), isArchived: archived, duplicate: false };
      });
    },
  };
}
