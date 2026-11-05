// Grants the `member` claim (and optionally `owner`) to an EXISTING Firebase Auth user.
// Usage (from /backend):  node scripts/grant-member.js user@example.com [--owner]
//
// --owner also creates the owner record (system/owner) so nobody else can become owner by registering.
// Refuses to replace an existing different owner.
import 'dotenv/config';
import { initAdmin } from '../src/firebase.js';

const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error('Usage: node scripts/grant-member.js <email> [--owner]');
  process.exit(1);
}
const owner = flag === '--owner';

try {
  const { auth, db } = initAdmin({ FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON });
  const user = await auth.getUserByEmail(email);

  if (owner) {
    const ref = db.collection('system').doc('owner');
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) tx.create(ref, { uid: user.uid, createdAt: Date.now() });
      else if (snap.get('uid') !== user.uid) {
        throw new Error(`Another owner already exists (uid ${snap.get('uid')}). Run without --owner to add a normal member.`);
      }
    });
  }

  await auth.setCustomUserClaims(user.uid, { member: true, ...(owner ? { owner: true } : {}) });
  console.log(`OK: ${email} (${user.uid}) is now ${owner ? 'the owner' : 'a member'}. Sign in again in the app.`);
  process.exit(0);
} catch (e) {
  console.error('Failed:', e.message);
  process.exit(1);
}