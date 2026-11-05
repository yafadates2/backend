// Idempotent: creates documents that don't exist yet and never overwrites existing ones.
//   cd backend && npm run seed
import 'dotenv/config';
import { FieldValue } from 'firebase-admin/firestore';
import { initAdmin } from '../src/firebase.js';
import { buildDocs } from './seed-data.js';

const { db } = initAdmin({ FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON });
let created = 0;
let skipped = 0;
for (const { path, data } of buildDocs(FieldValue.serverTimestamp())) {
  try {
    await db.doc(path).create(data);
    created++;
  } catch (e) {
    if (e.code === 6) skipped++; // 6 = ALREADY_EXISTS
    else throw e;
  }
}
console.log(`Seed done: ${created} created, ${skipped} already existed (left untouched).`);
process.exit(0);
