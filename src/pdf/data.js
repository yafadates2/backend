import {
  MAX_PERIOD_DAYS, daysInclusive, eachDate, formatBusinessDate, formatDateTime, isValidBusinessDate, toDate,
} from './format.js';

export class PdfDataError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const MAX_STATEMENT_ROWS = 2000;
const MAX_EXPENSE_ROWS = 1000;
const MAX_SALES_ROWS = 500;
const int = (v) => (Number.isSafeInteger(v) ? v : 0);
const time = (v) => { const d = toDate(v); return d ? d.getTime() : typeof v === 'number' ? v : 0; };

export function assertPeriod(from, to) {
  if (!isValidBusinessDate(from) || !isValidBusinessDate(to) || from > to) throw new PdfDataError('invalid_period');
  if (daysInclusive(from, to) > MAX_PERIOD_DAYS) throw new PdfDataError('period_too_long');
}

/**
 * Reads Firestore (Admin SDK, read-only) and returns plain document models for the templates.
 * Nothing here writes. Money stays integer minor units.
 */
export function createPdfDataService({ db, imageStore, timeZone = 'Africa/Tunis', now = () => new Date(), logger }) {
  const logoCache = new Map(); // key -> data URI (keys are immutable, so this never goes stale)
  const generatedText = () => formatDateTime(now(), timeZone);

  async function shop() {
    const snap = await db.collection('shop_settings').doc('main').get();
    const d = snap.exists ? snap.data() : {};
    let logoDataUri = null;
    const key = d.logoKey;
    if (typeof key === 'string' && imageStore?.get) {
      if (logoCache.has(key)) logoDataUri = logoCache.get(key);
      else {
        try {
          logoDataUri = `data:image/webp;base64,${(await imageStore.get(key)).toString('base64')}`;
          logoCache.set(key, logoDataUri);
        } catch (err) {
          logger?.warn({ err }, 'logo unavailable for PDF, continuing without it'); // never block a bill over the logo
        }
      }
    }
    return {
      name: d.name ?? '', phone: d.phone ?? '', address: d.address ?? '', logoDataUri,
      decimals: Number.isInteger(d.minorUnitDecimals) ? d.minorUnitDecimals : 3,
      symbol: d.currencySymbol ?? d.currencyCode ?? '',
    };
  }

  const party = (snap, fallbackName = '') => (snap?.exists
    ? { name: snap.get('name') ?? fallbackName, phone: snap.get('phone') ?? '', address: snap.get('address') ?? '' }
    : fallbackName ? { name: fallbackName, phone: '', address: '' } : null);

  const need = (snap) => { if (!snap.exists) throw new PdfDataError('not_found', 404); return snap; };
  const sortedItems = (snap) => snap.docs.map((x) => ({ n: x.id, ...x.data() })).sort((a, b) => (a.n < b.n ? -1 : 1));
  const methodKey = (cashPaid, credit) => (credit > 0 ? (cashPaid > 0 ? 'both' : 'credit') : 'cash');

  async function saleBill(id) {
    const saleSnap = need(await db.collection('sales').doc(id).get());
    const s = saleSnap.data();
    const [items, clientSnap] = await Promise.all([
      db.collection('sales').doc(id).collection('sale_items').get(),
      s.clientId ? db.collection('clients').doc(s.clientId).get() : null,
    ]);
    return {
      kind: 'bill', variant: 'sale', number: s.number ?? id,
      dateText: formatDateTime(s.createdAt, timeZone) || formatBusinessDate(s.businessDate),
      party: s.clientId ? party(clientSnap, s.clientName ?? '') : null,
      lines: sortedItems(items).map((it) => ({ name: it.productName ?? '', qty: int(it.qty), unit: int(it.unitPrice), total: int(it.lineTotal) })),
      subtotal: int(s.subtotal), discount: int(s.discount), extraCosts: 0, total: int(s.total),
      paid: int(s.paidTotal), remaining: int(s.remaining), methodKey: methodKey(int(s.cashPaid), int(s.credit)),
      note: s.note ?? '',
      voided: s.status === 'voided' ? { reason: s.voidReason ?? '' } : null,
    };
  }

  async function purchaseBill(id) {
    const snap = need(await db.collection('purchases').doc(id).get());
    const p = snap.data();
    const [items, supplierSnap] = await Promise.all([
      db.collection('purchases').doc(id).collection('purchase_items').get(),
      p.supplierId ? db.collection('suppliers').doc(p.supplierId).get() : null,
    ]);
    return {
      kind: 'bill', variant: 'purchase', number: p.number ?? id, invoiceRef: p.invoiceRef ?? '',
      dateText: formatDateTime(p.createdAt, timeZone) || formatBusinessDate(p.businessDate),
      party: party(supplierSnap, p.supplierName ?? ''),
      lines: sortedItems(items).map((it) => ({ name: it.productName ?? '', qty: int(it.qty), unit: int(it.unitCost), total: int(it.lineTotal) })),
      subtotal: int(p.subtotal), discount: int(p.discount), extraCosts: int(p.extraCosts), total: int(p.total),
      paid: int(p.paidTotal), remaining: int(p.remaining), methodKey: methodKey(int(p.cashPaid), int(p.credit)),
      note: p.note ?? '',
      voided: p.status === 'voided' ? { reason: p.voidReason ?? '' } : null,
    };
  }

  async function receipt(variant, id) {
    const customer = variant === 'customer';
    const snap = need(await db.collection(customer ? 'customer_payments' : 'supplier_payments').doc(id).get());
    const pay = snap.data();
    const partyId = customer ? pay.clientId : pay.supplierId;
    const partySnap = partyId ? await db.collection(customer ? 'clients' : 'suppliers').doc(partyId).get() : null;
    const allocations = Array.isArray(pay.allocations) ? pay.allocations : [];
    const docCol = customer ? 'sales' : 'purchases';
    const refs = allocations.map((a) => db.collection(docCol).doc(a.saleId ?? a.purchaseId));
    const docs = refs.length ? await db.getAll(...refs) : [];
    return {
      kind: 'receipt', variant, number: pay.number ?? id,
      dateText: formatDateTime(pay.createdAt, timeZone) || formatBusinessDate(pay.businessDate),
      party: party(partySnap, (customer ? pay.clientName : pay.supplierName) ?? ''),
      amount: int(pay.amount),
      allocations: allocations.map((a, i) => ({ number: docs[i]?.exists ? docs[i].get('number') ?? docs[i].id : (a.saleId ?? a.purchaseId), amount: int(a.amount) })),
      balanceNow: partySnap?.exists ? int(partySnap.get('balance')) : 0,
      note: pay.note ?? '',
    };
  }

  /**
   * Account statement. Balance deltas: sale/purchase +credit (the part put on account), payment -amount,
   * void -remainingCancelled. Opening balance = balance now minus every delta dated on/after `from`
   * (the balance is the sum of its history; `npm run reconcile` checks that invariant).
   */
  async function statement(variant, id, from, to) {
    assertPeriod(from, to);
    const client = variant === 'client';
    const partySnap = need(await db.collection(client ? 'clients' : 'suppliers').doc(id).get());
    const idField = client ? 'clientId' : 'supplierId';
    const capped = async (col) => {
      const snap = await db.collection(col).where(idField, '==', id).limit(MAX_STATEMENT_ROWS + 1).get();
      if (snap.docs.length > MAX_STATEMENT_ROWS) throw new PdfDataError('statement_too_large', 413);
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    };
    const [docsRaw, paysRaw, voidsRaw] = await Promise.all([
      capped(client ? 'sales' : 'purchases'),
      capped(client ? 'customer_payments' : 'supplier_payments'),
      capped(client ? 'sale_voids' : 'purchase_voids'),
    ]);
    const events = [];
    for (const d of docsRaw) {
      const credit = int(d.credit);
      if (credit > 0) events.push({ date: d.businessDate, t: time(d.createdAt), id: d.id, label: client ? 'saleEntry' : 'purchaseEntry', ref: d.number ?? d.id, delta: credit });
    }
    for (const p of paysRaw) events.push({ date: p.businessDate, t: time(p.createdAt), id: p.id, label: 'paymentEntry', ref: p.number ?? p.id, delta: -int(p.amount) });
    for (const v of voidsRaw) {
      const rem = int(v.remainingCancelled);
      if (rem > 0) events.push({ date: v.businessDate, t: time(v.createdAt), id: v.id, label: 'voidEntry', ref: v.number ?? v.id, delta: -rem });
    }
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.t - b.t || (a.id < b.id ? -1 : 1)));

    const balanceNow = int(partySnap.get('balance'));
    const sumFrom = events.filter((x) => x.date >= from).reduce((acc, x) => acc + x.delta, 0);
    const opening = balanceNow - sumFrom;
    let running = opening;
    const rows = [];
    for (const x of events.filter((y) => y.date >= from && y.date <= to)) {
      running += x.delta;
      rows.push({
        dateText: formatBusinessDate(x.date), labelKey: x.label, ref: x.ref,
        debit: x.delta > 0 ? x.delta : 0, credit: x.delta < 0 ? -x.delta : 0, balance: running,
      });
    }
    return {
      kind: 'statement', variant, party: party(partySnap), fromText: formatBusinessDate(from), toText: formatBusinessDate(to),
      opening, closing: running, balanceNow, rows, generatedText: generatedText(),
    };
  }

  async function expenseReport({ from, to, categoryId }) {
    assertPeriod(from, to);
    const snap = await db.collection('expenses')
      .where('isArchived', '==', false)
      .where('businessDate', '>=', from).where('businessDate', '<=', to)
      .orderBy('businessDate', 'desc').limit(MAX_EXPENSE_ROWS + 1).get();
    const truncated = snap.docs.length > MAX_EXPENSE_ROWS;
    let all = snap.docs.slice(0, MAX_EXPENSE_ROWS).map((d) => ({ id: d.id, ...d.data() }));
    let categoryName = null;
    if (categoryId) {
      all = all.filter((x) => x.categoryId === categoryId);
      const c = await db.collection('expense_categories').doc(categoryId).get();
      categoryName = c.exists ? c.get('name') ?? '' : (all[0]?.categoryName ?? '');
    }
    const byCat = new Map();
    let total = 0;
    for (const x of all) {
      total += int(x.amount);
      const k = x.categoryId ?? '';
      const cur = byCat.get(k) ?? { name: x.categoryName ?? '', count: 0, total: 0 };
      cur.count += 1; cur.total += int(x.amount);
      byCat.set(k, cur);
    }
    return {
      kind: 'expenseReport', fromText: formatBusinessDate(from), toText: formatBusinessDate(to), categoryName,
      rows: all.map((x) => ({ dateText: formatBusinessDate(x.businessDate), number: x.number ?? x.id, title: x.title ?? '', categoryName: x.categoryName ?? '', amount: int(x.amount) })),
      byCategory: [...byCat.values()].sort((a, b) => b.total - a.total),
      total, count: all.length, truncated, generatedText: generatedText(),
    };
  }

  async function salesReport({ from, to }) {
    assertPeriod(from, to);
    const dates = eachDate(from, to);
    const [statDocs, salesSnap] = await Promise.all([
      db.getAll(...dates.map((d) => db.collection('daily_stats').doc(d))),
      db.collection('sales').where('businessDate', '>=', from).where('businessDate', '<=', to)
        .orderBy('businessDate', 'desc').limit(MAX_SALES_ROWS + 1).get(),
    ]);
    const days = [];
    const totals = { salesCount: 0, gross: 0, voided: 0, net: 0, cash: 0, credit: 0, payments: 0, profit: 0 };
    statDocs.forEach((sd, i) => {
      if (!sd.exists) return;
      const x = sd.data();
      const gross = int(x.salesTotal); const voided = int(x.voidedTotal);
      const row = {
        dateText: formatBusinessDate(dates[i]), salesCount: int(x.salesCount), gross, voided, net: gross - voided,
        cash: int(x.cashSales), credit: int(x.creditSales), payments: int(x.paymentsReceived),
        // gross profit = (sales - cost of sales) - (voided sales - cost of voided sales)
        profit: (gross - int(x.cogs)) - (voided - int(x.voidedCogs)),
      };
      if (!row.salesCount && !gross && !voided && !row.payments) return; // a stats doc that only holds purchases/expenses
      days.push(row);
      for (const k of Object.keys(totals)) totals[k] += row[k];
    });
    const truncated = salesSnap.docs.length > MAX_SALES_ROWS;
    return {
      kind: 'salesReport', fromText: formatBusinessDate(from), toText: formatBusinessDate(to), days, totals,
      sales: salesSnap.docs.slice(0, MAX_SALES_ROWS).map((d) => {
        const x = d.data();
        return { dateText: formatBusinessDate(x.businessDate), number: x.number ?? d.id, clientName: x.clientName ?? '', total: int(x.total), paid: int(x.paidTotal), voided: x.status === 'voided' };
      }),
      truncated, generatedText: generatedText(),
    };
  }

  /**
   * Profit and loss from `daily_stats` only (one getAll, no scans).
   * gross profit = (sales - voided sales) - (cost of sales - cost of voided sales); net profit = gross profit - expenses.
   * Cash in = counter cash + customer payments - refunds recorded on voids.
   */
  async function profitReport({ from, to }) {
    assertPeriod(from, to);
    const dates = eachDate(from, to);
    const statDocs = await db.getAll(...dates.map((d) => db.collection('daily_stats').doc(d)));
    const keys = ['gross', 'voided', 'net', 'cogs', 'discounts', 'grossProfit', 'expenses', 'netProfit', 'cashIn', 'credit', 'purchases', 'supplierPaid'];
    const totals = Object.fromEntries(keys.map((k) => [k, 0]));
    const days = [];
    statDocs.forEach((sd, i) => {
      if (!sd.exists) return;
      const x = sd.data();
      const gross = int(x.salesTotal); const voided = int(x.voidedTotal);
      const cogs = int(x.cogs) - int(x.voidedCogs);
      const row = {
        gross, voided, net: gross - voided, cogs, discounts: int(x.discountTotal),
        grossProfit: gross - voided - cogs, expenses: int(x.expensesTotal),
        cashIn: int(x.cashSales) + int(x.paymentsReceived) - int(x.voidedRefunds), credit: int(x.creditSales),
        purchases: int(x.purchasesTotal) - int(x.purchaseVoidedTotal), supplierPaid: int(x.supplierPaymentsPaid),
      };
      row.netProfit = row.grossProfit - row.expenses;
      if (keys.every((k) => row[k] === 0)) return;
      days.push({ dateText: formatBusinessDate(dates[i]), ...row });
      for (const k of keys) totals[k] += row[k];
    });
    return { kind: 'profitReport', fromText: formatBusinessDate(from), toText: formatBusinessDate(to), days, totals, generatedText: generatedText() };
  }

  return { shop, saleBill, purchaseBill, receipt, statement, expenseReport, salesReport, profitReport };
}
