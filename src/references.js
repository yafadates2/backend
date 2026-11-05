// Which image keys does Firestore still point to? (Admin SDK: bypasses security rules.)
export function createReferenceChecker(db) {
  return async function isReferenced(key) {
    const [p, c, s, e] = await Promise.all([
      db.collection('products').where('imageKey', '==', key).limit(1).get(),
      db.collection('categories').where('imageKey', '==', key).limit(1).get(),
      db.doc('shop_settings/main').get(),
      db.collection('expenses').where('attachmentKey', '==', key).limit(1).get(),
    ]);
    return !p.empty || !c.empty || !e.empty || (s.exists && s.get('logoKey') === key);
  };
}

export async function collectReferencedKeys(db) {
  const keys = new Set();
  for (const col of ['products', 'categories']) {
    const snap = await db.collection(col).select('imageKey').get();
    snap.forEach((d) => { const k = d.get('imageKey'); if (typeof k === 'string') keys.add(k); });
  }
  const ex = await db.collection('expenses').select('attachmentKey').get();
  ex.forEach((d) => { const k = d.get('attachmentKey'); if (typeof k === 'string') keys.add(k); });
  const s = await db.doc('shop_settings/main').get();
  if (s.exists && typeof s.get('logoKey') === 'string') keys.add(s.get('logoKey'));
  return keys;
}
