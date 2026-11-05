// Tiny in-memory stand-in for the Admin SDK Firestore, just enough for src/sales.js:
// doc/collection refs, getAll, get(query), create/set/update, where(==)/orderBy/limit,
// FieldValue.increment / serverTimestamp, and all-or-nothing transactions.
export const fieldValue = {
  increment: (n) => ({ __inc: n }),
  serverTimestamp: () => ({ __ts: true }),
};

const clone = (v) => (v === undefined ? v : structuredClone(v));

function applyValue(prev, key, v) {
  if (v && typeof v === 'object' && '__inc' in v) return (prev?.[key] ?? 0) + v.__inc;
  if (v && typeof v === 'object' && '__ts' in v) return new Date(0);
  return v;
}

export function createFakeDb() {
  const store = new Map(); // path -> data
  let tick = 0;

  const snap = (path) => {
    const data = store.get(path);
    return {
      id: path.split('/').pop(),
      exists: data !== undefined,
      data: () => clone(data),
      get: (k) => clone(data?.[k]),
    };
  };

  const docRef = (path) => ({
    path,
    id: path.split('/').pop(),
    collection: (name) => colRef(`${path}/${name}`),
    get: async () => snap(path), // read-only services (PDF) use ref.get()
  });

  function colRef(path, filters = [], order = null, max = null) {
    const q = {
      path,
      doc: (id) => docRef(`${path}/${id}`),
      where: (f, op, v) => {
        if (!['==', '>=', '<=', '>', '<'].includes(op)) throw new Error(`fake does not support ${op}`);
        return colRef(path, [...filters, [f, v, op]], order, max);
      },
      orderBy: (f, dir = 'asc') => colRef(path, filters, [f, dir], max),
      limit: (n) => colRef(path, filters, order, n),
      get: async () => {
        const r = q.__run();
        return { ...r, empty: r.docs.length === 0, size: r.docs.length };
      },
      __run: () => {
        const prefix = `${path}/`;
        let docs = [...store.entries()]
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
          .filter(([, d]) => filters.every(([f, v, op = '==']) => (
            op === '==' ? d[f] === v : op === '>=' ? d[f] >= v : op === '<=' ? d[f] <= v : op === '>' ? d[f] > v : d[f] < v)))
          .map(([p, d]) => ({ p, d }));
        if (order) {
          const [f, dir] = order;
          docs.sort((a, b) => {
            const x = a.d[f]; const y = b.d[f];
            const c = x < y ? -1 : x > y ? 1 : 0;
            return dir === 'desc' ? -c : c;
          });
        }
        if (max != null) docs = docs.slice(0, max);
        return {
          docs: docs.map(({ p }) => ({ ...snap(p), data: () => clone(store.get(p)) })),
        };
      },
    };
    return q;
  }

  const db = {
    store,
    collection: (name) => colRef(name),
    getAll: async (...refs) => refs.map((r) => snap(r.path)),
    /** Seed without going through a transaction. */
    seed(path, data) {
      store.set(path, clone({ createdAt: ++tick, ...data }));
    },
    get: (path) => clone(store.get(path)),
    async runTransaction(fn) {
      const writes = [];
      let wrote = false;
      const tx = {
        getAll: async (...refs) => {
          if (wrote) throw new Error('read after write in transaction');
          return refs.map((r) => snap(r.path));
        },
        get: async (target) => {
          if (wrote) throw new Error('read after write in transaction');
          return target.__run ? target.__run() : snap(target.path);
        },
        create: (ref, data) => { wrote = true; writes.push(['create', ref.path, data]); },
        set: (ref, data, opts) => { wrote = true; writes.push(['set', ref.path, data, opts]); },
        update: (ref, data) => { wrote = true; writes.push(['update', ref.path, data]); },
      };
      const result = await fn(tx);
      // commit: validate everything first so a failure leaves the store untouched
      const next = new Map(store);
      for (const [op, path, data, opts] of writes) {
        const prev = next.get(path);
        if (op === 'create' && prev !== undefined) throw new Error(`ALREADY_EXISTS ${path}`);
        if (op === 'update' && prev === undefined) throw new Error(`NOT_FOUND ${path}`);
        const base = op === 'create' || (op === 'set' && !opts?.merge) ? {} : { ...prev };
        const out = { ...base };
        for (const [k, v] of Object.entries(data)) out[k] = applyValue(prev, k, v);
        if (out.createdAt instanceof Date) out.createdAt = ++tick; // monotonic stand-in for server time
        next.set(path, out);
      }
      store.clear();
      for (const [k, v] of next) store.set(k, v);
      return result;
    },
  };
  return db;
}
