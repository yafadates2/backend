// Runs only against the Firestore emulator, from the project root:
//   firebase emulators:exec --only firestore "cd backend && npm test"
// Needs: npm i -D @firebase/rules-unit-testing firebase
import { readFileSync } from 'node:fs';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';

const hostPort = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!hostPort)('firestore.rules', () => {
  let env, assertSucceeds, assertFails, fs;

  const settings = {
    name: 'تمور يافا', phone: '', address: '', currencyCode: 'TND', currencySymbol: 'د.ت',
    minorUnitDecimals: 3, defaultLanguage: 'ar', allowNegativeStock: false, invoicePrefix: 'TY',
  };
  const category = { name: 'التمور', isArchived: false };
  const product = {
    name: 'رب 250غ', categoryId: 'c1', imageKey: null, avgCost: 0, sellingPrice: 6500,
    stockQty: 0, minStock: 0, description: '', isActive: true,
  };

  beforeAll(async () => {
    const rt = await import('@firebase/rules-unit-testing');
    fs = await import('firebase/firestore');
    ({ assertSucceeds, assertFails } = rt);
    const [host, port] = hostPort.split(':');
    env = await rt.initializeTestEnvironment({
      projectId: 'demo-shop-rules',
      firestore: {
        host, port: Number(port),
        rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
      },
    });
  });
  afterAll(async () => env?.cleanup());
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await fs.setDoc(fs.doc(db, 'categories/c1'), category);
      await fs.setDoc(fs.doc(db, 'shop_settings/main'), settings);
      await fs.setDoc(fs.doc(db, 'products/p1'), product);
      await fs.setDoc(fs.doc(db, 'invites/x'), { usedBy: null });
    });
  });

  const member = () => env.authenticatedContext('u1', { member: true }).firestore();
  const stranger = () => env.authenticatedContext('u2').firestore(); // signed up, but not a member
  const anon = () => env.unauthenticatedContext().firestore();
  const ref = (db, path) => fs.doc(db, path);

  it('anonymous users and non-members cannot read anything', async () => {
    for (const path of ['shop_settings/main', 'categories/c1', 'products/p1', 'sales/s1']) {
      await assertFails(fs.getDoc(ref(anon(), path)));
      await assertFails(fs.getDoc(ref(stranger(), path)));
    }
  });
  it('a non-member cannot write', async () => {
    await assertFails(fs.setDoc(ref(stranger(), 'categories/c2'), category));
    await assertFails(fs.updateDoc(ref(stranger(), 'shop_settings/main'), { name: 'X' }));
  });
  it('members can read shop data', async () => {
    for (const path of ['shop_settings/main', 'categories/c1', 'products/p1', 'sales/s1']) {
      await assertSucceeds(fs.getDoc(ref(member(), path)));
    }
  });

  describe('shop_settings', () => {
    it('allows a valid update', async () => {
      await assertSucceeds(fs.updateDoc(ref(member(), 'shop_settings/main'), { phone: '71 000 000', defaultLanguage: 'fr' }));
    });
    it('rejects an unsupported language, unknown fields, bad currency and empty name', async () => {
      const r = ref(member(), 'shop_settings/main');
      await assertFails(fs.updateDoc(r, { defaultLanguage: 'en' }));
      await assertFails(fs.updateDoc(r, { hacked: true }));
      await assertFails(fs.updateDoc(r, { currencyCode: 'TNDX' }));
      await assertFails(fs.updateDoc(r, { name: '' }));
    });
    it('never allows changing the money decimals, or deleting the document', async () => {
      await assertFails(fs.updateDoc(ref(member(), 'shop_settings/main'), { minorUnitDecimals: 2 }));
      await assertFails(fs.deleteDoc(ref(member(), 'shop_settings/main')));
    });
    it('only the document id "main" is allowed', async () => {
      await assertFails(fs.setDoc(ref(member(), 'shop_settings/other'), settings));
    });
  });

  describe('categories', () => {
    it('create / update / delete valid', async () => {
      await assertSucceeds(fs.setDoc(ref(member(), 'categories/c2'), { ...category, name: 'الزيت', createdAt: fs.serverTimestamp() }));
      await assertSucceeds(fs.updateDoc(ref(member(), 'categories/c1'), { name: 'تمور' }));
      await assertSucceeds(fs.deleteDoc(ref(member(), 'categories/c1')));
    });
    it('rejects empty names and unknown fields', async () => {
      await assertFails(fs.setDoc(ref(member(), 'categories/c2'), { ...category, name: '' }));
      await assertFails(fs.setDoc(ref(member(), 'categories/c2'), { ...category, extra: 1 }));
    });
  });

  describe('products', () => {
    it('create with an existing category; update price', async () => {
      await assertSucceeds(fs.setDoc(ref(member(), 'products/p2'), product));
      await assertSucceeds(fs.updateDoc(ref(member(), 'products/p1'), { sellingPrice: 7000 }));
    });
    it('rejects an unknown category', async () => {
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), { ...product, categoryId: 'nope' }));
      await assertFails(fs.updateDoc(ref(member(), 'products/p1'), { categoryId: 'nope' }));
    });
    it('rejects non-integer, negative or missing money fields', async () => {
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), { ...product, sellingPrice: 6.5 }));
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), { ...product, sellingPrice: -1 }));
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), { ...product, avgCost: -5 }));
      const { avgCost, ...missing } = product;
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), missing));
    });
    it('rejects unknown fields and hard deletes', async () => {
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), { ...product, discount: 1 }));
      await assertFails(fs.deleteDoc(ref(member(), 'products/p1')));
    });
  });

  describe('stock (Phase 4): product stock changes only with a matching stock_movement', () => {
    // p1 starts at qty 10, avgCost 1000
    beforeEach(async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await fs.updateDoc(fs.doc(ctx.firestore(), 'products/p1'), { stockQty: 10, avgCost: 1000 });
      });
    });
    const movement = (o = {}) => ({
      productId: 'p1', type: 'stock_in', delta: 10, qtyBefore: 10, qtyAfter: 20, unitCost: 2000,
      avgCostBefore: 1000, avgCostAfter: 1500, reason: 'received', businessDate: '2026-11-02',
      createdBy: 'u1', createdAt: fs.serverTimestamp(), ...o,
    });
    const commit = (db, mov, prod, mid = 'm1') => {
      const b = fs.writeBatch(db);
      b.set(fs.doc(db, `stock_movements/${mid}`), mov);
      b.update(fs.doc(db, 'products/p1'), { ...prod, lastMovementId: mid });
      return b.commit();
    };

    it('a new product must start with zero stock and zero cost', async () => {
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), { ...product, stockQty: 5 }));
      await assertFails(fs.setDoc(ref(member(), 'products/p2'), { ...product, avgCost: 100 }));
    });
    it('editing stockQty or avgCost directly (no movement) is refused', async () => {
      await assertFails(fs.updateDoc(ref(member(), 'products/p1'), { stockQty: 999 }));
      await assertFails(fs.updateDoc(ref(member(), 'products/p1'), { avgCost: 1 }));
    });
    it('a valid stock_in with correct weighted average commits', async () => {
      await assertSucceeds(commit(member(), movement(), { stockQty: 20, avgCost: 1500 }));
    });
    it('rounds the average half up (10@1000 + 1@1500 -> 1045)', async () => {
      await assertSucceeds(commit(member(),
        movement({ delta: 1, qtyAfter: 11, unitCost: 1500, avgCostAfter: 1045 }), { stockQty: 11, avgCost: 1045 }));
    });
    it('rejects a wrong average, wrong quantity or wrong before-state', async () => {
      await assertFails(commit(member(), movement({ avgCostAfter: 1800 }), { stockQty: 20, avgCost: 1800 }));
      await assertFails(commit(member(), movement({ qtyAfter: 25, delta: 15 }), { stockQty: 25, avgCost: 1500 }));
      await assertFails(commit(member(), movement({ qtyBefore: 5, qtyAfter: 15 }), { stockQty: 15, avgCost: 1500 }));
    });
    it('product and movement must agree', async () => {
      await assertFails(commit(member(), movement(), { stockQty: 21, avgCost: 1500 }));
      await assertFails(commit(member(), movement(), { stockQty: 20, avgCost: 1400 }));
    });
    it('a movement alone (product untouched) or a product change alone is refused', async () => {
      await assertFails(fs.setDoc(ref(member(), 'stock_movements/m1'), movement()));
      await assertFails(fs.updateDoc(ref(member(), 'products/p1'), { stockQty: 20, avgCost: 1500, lastMovementId: 'nope' }));
    });
    it('adjustments keep the cost; negative stock needs allowNegativeStock', async () => {
      const adj = (o) => movement({ type: 'adjustment', reason: 'damaged', delta: -3, qtyAfter: 7, avgCostAfter: 1000, unitCost: undefined, ...o });
      const clean = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
      await assertSucceeds(commit(member(), clean(adj()), { stockQty: 7, avgCost: 1000 }));
      await assertFails(commit(member(), clean(adj({ delta: -12, qtyAfter: -2 })), { stockQty: -2, avgCost: 1000 }, 'm2'));
      await assertFails(commit(member(), clean(adj({ avgCostAfter: 900 })), { stockQty: 7, avgCost: 900 }, 'm3'));
    });
    it('createdBy must be the caller, and movements are immutable', async () => {
      await assertFails(commit(member(), movement({ createdBy: 'someone-else' }), { stockQty: 20, avgCost: 1500 }));
      await assertSucceeds(commit(member(), movement(), { stockQty: 20, avgCost: 1500 }));
      await assertFails(fs.updateDoc(ref(member(), 'stock_movements/m1'), { note: 'x' }));
      await assertFails(fs.deleteDoc(ref(member(), 'stock_movements/m1')));
    });
    it('non-members cannot create movements', async () => {
      await assertFails(commit(stranger(), movement(), { stockQty: 20, avgCost: 1500 }));
    });
    it('ordinary product edits (price, name, archive) still work and keep the stock', async () => {
      await assertSucceeds(fs.updateDoc(ref(member(), 'products/p1'), { sellingPrice: 7000, isActive: false }));
    });
  });

  describe('clients and suppliers (Phase 5)', () => {
    const party = { name: 'أحمد', phone: '98123456', address: '', notes: '', balance: 0, totalPurchases: 0, isArchived: false };
    for (const col of ['clients', 'suppliers']) {
      describe(col, () => {
        const path = `${col}/x1`;
        beforeEach(async () => {
          await env.withSecurityRulesDisabled(async (ctx) => {
            await fs.setDoc(fs.doc(ctx.firestore(), path), { ...party, balance: 5000, totalPurchases: 20000 });
          });
        });
        it('a member creates one starting at zero balance and zero totals', async () => {
          await assertSucceeds(fs.setDoc(ref(member(), `${col}/new1`), party));
        });
        it('rejects a non-zero balance/total or an archived start, unknown fields, empty or too long text', async () => {
          await assertFails(fs.setDoc(ref(member(), `${col}/n2`), { ...party, balance: 100 }));
          await assertFails(fs.setDoc(ref(member(), `${col}/n3`), { ...party, totalPurchases: 1 }));
          await assertFails(fs.setDoc(ref(member(), `${col}/n4`), { ...party, isArchived: true }));
          await assertFails(fs.setDoc(ref(member(), `${col}/n5`), { ...party, extra: 1 }));
          await assertFails(fs.setDoc(ref(member(), `${col}/n6`), { ...party, name: '' }));
          await assertFails(fs.setDoc(ref(member(), `${col}/n7`), { ...party, notes: 'x'.repeat(501) }));
        });
        it('edits and archiving work, balance and totals cannot be changed by hand', async () => {
          await assertSucceeds(fs.updateDoc(ref(member(), path), { name: 'علي', phone: '', isArchived: true }));
          await assertFails(fs.updateDoc(ref(member(), path), { balance: 0 }));
          await assertFails(fs.updateDoc(ref(member(), path), { totalPurchases: 0 }));
        });
        it('never deletable, not accessible to non-members', async () => {
          await assertFails(fs.deleteDoc(ref(member(), path)));
          await assertFails(fs.getDoc(ref(stranger(), path)));
          await assertFails(fs.setDoc(ref(stranger(), `${col}/n8`), party));
          await assertSucceeds(fs.getDoc(ref(member(), path)));
        });
      });
    }
  });

  describe('expense categories (Phase 8)', () => {
    it('members can create, rename and archive, but not delete or write junk; strangers get nothing', async () => {
      const doc = (c) => ref(c, 'expense_categories/c1');
      await assertSucceeds(fs.setDoc(doc(member()), { name: 'الكراء', isArchived: false }));
      await assertSucceeds(fs.updateDoc(doc(member()), { name: 'كراء المحل', isArchived: true }));
      await assertSucceeds(fs.getDoc(doc(member())));
      await assertFails(fs.deleteDoc(doc(member())));
      await assertFails(fs.setDoc(doc(member()), { name: '', isArchived: false }));
      await assertFails(fs.setDoc(doc(member()), { name: 'x', isArchived: 'no' }));
      await assertFails(fs.setDoc(doc(member()), { name: 'x', isArchived: false, extra: 1 }));
      await assertFails(fs.setDoc(doc(stranger()), { name: 'x', isArchived: false }));
      await assertFails(fs.getDoc(doc(stranger())));
    });
  });

  describe('backend-only financial collections (Phase 6)', () => {
    const paths = ['sales/s1', 'sales/s1/sale_items/001', 'sale_voids/s1', 'customer_payments/p1',
                   'counters/sales', 'daily_stats/2026-11-03',
                   // Phase 7
                   'purchases/b1', 'purchases/b1/purchase_items/001', 'purchase_voids/b1', 'supplier_payments/sp1',
                   'counters/purchases', 'counters/supplier_payments',
                   // Phase 8
                   'expenses/e1', 'counters/expenses'];
    it('members can read them but never write them', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        for (const path of paths) await fs.setDoc(fs.doc(ctx.firestore(), path), { x: 1 });
      });
      for (const path of paths) {
        await assertSucceeds(fs.getDoc(ref(member(), path)));
        await assertFails(fs.setDoc(ref(member(), path), { x: 2 }));
        await assertFails(fs.deleteDoc(ref(member(), path)));
        await assertFails(fs.getDoc(ref(stranger(), path)));
      }
    });
    it('an app cannot touch a supplier balance or forge a purchase movement', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await fs.setDoc(fs.doc(ctx.firestore(), 'suppliers/s1'), {
          name: 's', phone: '', address: '', notes: '', balance: 0, totalPurchases: 0, isArchived: false,
        });
      });
      await assertFails(fs.updateDoc(ref(member(), 'suppliers/s1'), { balance: 5000 }));
      await assertFails(fs.updateDoc(ref(member(), 'suppliers/s1'), { totalPurchases: 5000 }));
      await assertFails(fs.setDoc(ref(member(), 'stock_movements/purchase_x_001'), {
        productId: 'p1', type: 'purchase', reason: 'purchase', delta: 1, qtyBefore: 0, qtyAfter: 1,
        avgCostBefore: 0, avgCostAfter: 100, businessDate: '2026-11-03', createdBy: 'u1',
      }));
    });
    it('an app cannot touch a client balance or forge a sale movement', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await fs.setDoc(fs.doc(ctx.firestore(), 'clients/k1'), {
          name: 'k', phone: '', address: '', notes: '', balance: 0, totalPurchases: 0, isArchived: false,
        });
      });
      await assertFails(fs.updateDoc(ref(member(), 'clients/k1'), { balance: 5000 }));
      await assertFails(fs.updateDoc(ref(member(), 'clients/k1'), { totalPurchases: 5000 }));
      await assertFails(fs.setDoc(ref(member(), 'stock_movements/sale_x_001'), {
        productId: 'p1', type: 'sale', reason: 'sale', delta: -1, qtyBefore: 0, qtyAfter: -1,
        avgCostBefore: 0, avgCostAfter: 0, businessDate: '2026-11-03', createdBy: 'u1',
        createdAt: fs.serverTimestamp(),
      }));
    });
  });

  describe('collections that stay closed until their phase', () => {
    it('members cannot write financial or party records yet', async () => {
      for (const path of ['sales/s1', 'stock_movements/m1',
                          'customer_payments/p1', 'expenses/e1', 'counters/sales']) {
        await assertFails(fs.setDoc(ref(member(), path), { x: 1 }));
      }
    });
    it('system and invites are backend-only', async () => {
      await assertFails(fs.getDoc(ref(member(), 'invites/x')));
      await assertFails(fs.getDoc(ref(member(), 'system/owner')));
      await assertFails(fs.setDoc(ref(member(), 'system/owner'), { uid: 'u1' }));
    });
    it('users can read only their own profile document', async () => {
      await assertSucceeds(fs.getDoc(ref(member(), 'users/u1')));
      await assertFails(fs.getDoc(ref(member(), 'users/other')));
    });
  });
});
