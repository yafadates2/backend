/**
 * Financial reconciliation (pure): re-derives every stored total from the immutable history and lists
 * disagreements. Rules cannot verify this maths, so this report is the safety net (`npm run reconcile`).
 *
 * Inputs are plain arrays of `{id, ...data}`; `items` is `{saleId: [{lineTotal, ...}]}` and `purchaseItems`
 * is `{purchaseId: [{lineTotal, landedTotal, ...}]}`.
 * Voided sales/purchases stay in the daily totals (they happened that day); their reversal is in the
 * `voided*` / `purchaseVoided*` fields of the day the void happened.
 * Phase 7/8 inputs are optional so older callers keep working.
 */
export function reconcile({
  products, movements, clients, sales, items = {}, voids = [], stats = [],
  suppliers = [], purchases = [], purchaseItems = {}, purchaseVoids = [], supplierPayments,
  expenses, // Phase 8, optional: archived expenses do not count in daily_stats
}) {
  const issues = [];
  const add = (kind, id, detail) => issues.push({ kind, id, detail });

  // ----- stock: quantity must equal the sum of its movements (products start at 0) -----
  const byProduct = new Map();
  for (const m of movements) {
    if (!byProduct.has(m.productId)) byProduct.set(m.productId, []);
    byProduct.get(m.productId).push(m);
  }
  for (const p of products) {
    const sum = (byProduct.get(p.id) ?? []).reduce((a, m) => a + m.delta, 0);
    if (sum !== (p.stockQty ?? 0)) add('stock_mismatch', p.id, `stockQty ${p.stockQty} vs movements ${sum}`);
  }

  // ----- sales -----
  const voidIds = new Set(voids.map((v) => v.id));
  for (const s of sales) {
    if (s.total !== s.subtotal - s.discount) add('sale_total', s.id, `total ${s.total} != subtotal ${s.subtotal} - discount ${s.discount}`);
    const lines = items[s.id] ?? [];
    const lineSum = lines.reduce((a, l) => a + l.lineTotal, 0);
    if (lines.length !== s.lineCount || lineSum !== s.subtotal) add('sale_items', s.id, `items ${lines.length}/${lineSum} vs ${s.lineCount}/${s.subtotal}`);
    if (s.status === 'active') {
      if (s.paidTotal + s.remaining !== s.total) add('sale_paid', s.id, `paid ${s.paidTotal} + remaining ${s.remaining} != total ${s.total}`);
      if (s.isOpen !== s.remaining > 0) add('sale_open_flag', s.id, `isOpen ${s.isOpen} with remaining ${s.remaining}`);
    } else if (s.status === 'voided') {
      if (!voidIds.has(s.id)) add('void_missing', s.id, 'voided sale without sale_voids document');
      if (s.remaining !== 0 || s.isOpen) add('void_open', s.id, 'voided sale still open');
    }
  }

  // ----- clients: balance = open credit on active sales; total = active sales -----
  for (const c of clients) {
    const mine = sales.filter((s) => s.clientId === c.id && s.status === 'active');
    const owed = mine.reduce((a, s) => a + s.remaining, 0);
    const total = mine.reduce((a, s) => a + s.total, 0);
    if (owed !== (c.balance ?? 0)) add('client_balance', c.id, `balance ${c.balance} vs open sales ${owed}`);
    if (total !== (c.totalPurchases ?? 0)) add('client_total', c.id, `totalPurchases ${c.totalPurchases} vs active sales ${total}`);
  }

  // ----- expenses (Phase 8) -----
  for (const e of expenses ?? []) {
    if (!Number.isSafeInteger(e.amount) || e.amount <= 0) add('expense_amount', e.id, `amount ${e.amount}`);
    if (e.method !== 'cash') add('expense_method', e.id, `method ${e.method}`);
  }

  // ----- purchases (Phase 7) -----
  const pVoidIds = new Set(purchaseVoids.map((v) => v.id));
  for (const p of purchases) {
    if (p.total !== p.subtotal - p.discount + p.extraCosts) {
      add('purchase_total', p.id, `total ${p.total} != subtotal ${p.subtotal} - discount ${p.discount} + extra ${p.extraCosts}`);
    }
    const lines = purchaseItems[p.id] ?? [];
    const lineSum = lines.reduce((a, l) => a + l.lineTotal, 0);
    const landedSum = lines.reduce((a, l) => a + l.landedTotal, 0);
    if (lines.length !== p.lineCount || lineSum !== p.subtotal || landedSum !== p.total) {
      add('purchase_items', p.id, `items ${lines.length}/${lineSum}/${landedSum} vs ${p.lineCount}/${p.subtotal}/${p.total}`);
    }
    if (p.status === 'active') {
      if (p.paidTotal + p.remaining !== p.total) add('purchase_paid', p.id, `paid ${p.paidTotal} + remaining ${p.remaining} != total ${p.total}`);
      if (p.isOpen !== p.remaining > 0) add('purchase_open_flag', p.id, `isOpen ${p.isOpen} with remaining ${p.remaining}`);
    } else if (p.status === 'voided') {
      if (!pVoidIds.has(p.id)) add('purchase_void_missing', p.id, 'voided purchase without purchase_voids document');
      if (p.remaining !== 0 || p.isOpen) add('purchase_void_open', p.id, 'voided purchase still open');
    }
  }

  // ----- suppliers: balance = open credit on active purchases; total = active purchases -----
  for (const s of suppliers) {
    const mine = purchases.filter((p) => p.supplierId === s.id && p.status === 'active');
    const owed = mine.reduce((a, p) => a + p.remaining, 0);
    const total = mine.reduce((a, p) => a + p.total, 0);
    if (owed !== (s.balance ?? 0)) add('supplier_balance', s.id, `balance ${s.balance} vs open purchases ${owed}`);
    if (total !== (s.totalPurchases ?? 0)) add('supplier_total', s.id, `totalPurchases ${s.totalPurchases} vs active purchases ${total}`);
  }

  // ----- daily stats: sales and purchase sides are derivable from the documents themselves -----
  const salesDay = new Map();
  for (const s of sales) {
    const d = salesDay.get(s.businessDate) ?? { count: 0, total: 0, cash: 0, credit: 0, cogs: 0 };
    d.count += 1; d.total += s.total; d.cash += s.cashPaid; d.credit += s.credit; d.cogs += s.cogs ?? 0;
    salesDay.set(s.businessDate, d);
  }
  const buyDay = new Map();
  for (const p of purchases) {
    const d = buyDay.get(p.businessDate) ?? { count: 0, total: 0, cash: 0, credit: 0, discount: 0, extra: 0 };
    d.count += 1; d.total += p.total; d.cash += p.cashPaid; d.credit += p.credit; d.discount += p.discount; d.extra += p.extraCosts;
    buyDay.set(p.businessDate, d);
  }
  const payDay = new Map();
  for (const sp of supplierPayments ?? []) {
    const d = payDay.get(sp.businessDate) ?? { count: 0, paid: 0 };
    d.count += 1; d.paid += sp.amount;
    payDay.set(sp.businessDate, d);
  }
  const expDay = new Map();
  for (const e of expenses ?? []) {
    if (e.isArchived === true) continue;
    const d = expDay.get(e.businessDate) ?? { count: 0, total: 0 };
    d.count += 1; d.total += e.amount;
    expDay.set(e.businessDate, d);
  }
  const seen = new Set();
  for (const st of stats) {
    seen.add(st.id);
    const s = salesDay.get(st.id) ?? { count: 0, total: 0, cash: 0, credit: 0, cogs: 0 };
    const got = [st.salesCount ?? 0, st.salesTotal ?? 0, st.cashSales ?? 0, st.creditSales ?? 0, st.cogs ?? 0];
    const want = [s.count, s.total, s.cash, s.credit, s.cogs];
    if (got.some((v, i) => v !== want[i])) add('daily_stats', st.id, `stats ${got} vs sales ${want}`);

    if (purchases.length || st.purchasesCount !== undefined) {
      const b = buyDay.get(st.id) ?? { count: 0, total: 0, cash: 0, credit: 0, discount: 0, extra: 0 };
      const pg = [st.purchasesCount ?? 0, st.purchasesTotal ?? 0, st.purchasesCash ?? 0, st.purchasesCredit ?? 0, st.purchasesDiscount ?? 0, st.purchasesExtra ?? 0];
      const pw = [b.count, b.total, b.cash, b.credit, b.discount, b.extra];
      if (pg.some((v, i) => v !== pw[i])) add('daily_stats_purchases', st.id, `stats ${pg} vs purchases ${pw}`);
    }
    if (expenses) {
      const x = expDay.get(st.id) ?? { count: 0, total: 0 };
      if ((st.expensesCount ?? 0) !== x.count || (st.expensesTotal ?? 0) !== x.total) {
        add('daily_stats_expenses', st.id, `stats ${st.expensesCount ?? 0}/${st.expensesTotal ?? 0} vs expenses ${x.count}/${x.total}`);
      }
    }
    if (supplierPayments) {
      const y = payDay.get(st.id) ?? { count: 0, paid: 0 };
      if ((st.supplierPaymentsCount ?? 0) !== y.count || (st.supplierPaymentsPaid ?? 0) !== y.paid) {
        add('daily_stats_supplier_payments', st.id, `stats ${st.supplierPaymentsCount ?? 0}/${st.supplierPaymentsPaid ?? 0} vs payments ${y.count}/${y.paid}`);
      }
    }
  }
  for (const [day] of salesDay) if (!seen.has(day)) add('daily_stats', day, 'sales exist but no daily_stats document');
  for (const [day] of buyDay) if (!seen.has(day)) add('daily_stats_purchases', day, 'purchases exist but no daily_stats document');
  for (const [day] of payDay) if (!seen.has(day)) add('daily_stats_supplier_payments', day, 'supplier payments exist but no daily_stats document');

  if (expenses) for (const [day] of expDay) if (!seen.has(day)) add('daily_stats_expenses', day, 'expenses exist but no daily_stats document');

  return issues;
}
