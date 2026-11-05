// Read-only financial consistency report:  npm run reconcile
// Exit code 1 when any disagreement is found. Reads whole collections: fine for one shop, not for millions.
import { loadConfig } from '../src/config.js';
import { initAdmin } from '../src/firebase.js';
import { reconcile } from '../src/reconcile.js';

const cfg = loadConfig();
const { db } = initAdmin(cfg);
const all = async (name) => (await db.collection(name).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

const [products, movements, clients, sales, voids, stats, suppliers, purchases, purchaseVoids, supplierPayments, expenses] =
  await Promise.all([
    'products', 'stock_movements', 'clients', 'sales', 'sale_voids', 'daily_stats',
    'suppliers', 'purchases', 'purchase_voids', 'supplier_payments', 'expenses',
  ].map(all));
const items = {};
for (const s of sales) {
  items[s.id] = (await db.collection('sales').doc(s.id).collection('sale_items').get()).docs.map((d) => d.data());
}
const purchaseItems = {};
for (const p of purchases) {
  purchaseItems[p.id] = (await db.collection('purchases').doc(p.id).collection('purchase_items').get()).docs.map((d) => d.data());
}
const issues = reconcile({
  products, movements, clients, sales, items, voids, stats,
  suppliers, purchases, purchaseItems, purchaseVoids, supplierPayments, expenses,
});
console.log(`products ${products.length}, movements ${movements.length}, clients ${clients.length}, sales ${sales.length}, suppliers ${suppliers.length}, purchases ${purchases.length}, expenses ${expenses.length}`);
if (!issues.length) {
  console.log('OK: stock, sales, purchases, expenses, client/supplier balances and daily stats all agree.');
} else {
  for (const i of issues) console.log(`${i.kind}\t${i.id}\t${i.detail}`);
  console.log(`${issues.length} problem(s) found.`);
  process.exitCode = 1;
}
