// Runs only against the Firestore emulator:
//   firebase emulators:exec --only firestore "cd backend && npm test"
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createMembershipService, MembershipError, INVITE_TTL_MS } from '../src/membership.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

describe.skipIf(!enabled)('membership (Firestore emulator)', () => {
  let db, claims, t, svc;

  beforeEach(async () => {
    if (!getApps().length) initializeApp({ projectId: 'demo-shop' });
    db = getFirestore();
    for (const c of ['system', 'invites']) {
      const snap = await db.collection(c).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
    claims = {};
    t = 1_000_000;
    svc = createMembershipService({
      db,
      auth: { setCustomUserClaims: async (uid, c) => { claims[uid] = c; } },
      now: () => t,
    });
  });

  it('first claimant becomes owner; claims are set', async () => {
    expect(await svc.claim('u1')).toEqual({ role: 'owner' });
    expect(claims.u1).toEqual({ member: true, owner: true });
  });

  it('owner re-claim is idempotent', async () => {
    await svc.claim('u1');
    expect(await svc.claim('u1')).toEqual({ role: 'owner' });
  });

  it('second user needs an invite', async () => {
    await svc.claim('u1');
    await expect(svc.claim('u2')).rejects.toBeInstanceOf(MembershipError);
    await expect(svc.claim('u2', 'WRONGCODE1')).rejects.toThrow('Invalid invite code');
    expect(claims.u2).toBeUndefined();
  });

  it('invite works once, for one user', async () => {
    await svc.claim('u1');
    const { code } = await svc.createInvite('u1');
    expect(await svc.claim('u2', code.toLowerCase())).toEqual({ role: 'member' });
    expect(claims.u2).toEqual({ member: true });
    await expect(svc.claim('u3', code)).rejects.toThrow('already used');
    expect(await svc.claim('u2', code)).toEqual({ role: 'member' }); // same user may retry
  });

  it('invite expires', async () => {
    await svc.claim('u1');
    const { code } = await svc.createInvite('u1');
    t += INVITE_TTL_MS + 1;
    await expect(svc.claim('u2', code)).rejects.toThrow('expired');
  });

  it('only one of two concurrent first claims becomes owner', async () => {
    const results = await Promise.allSettled([svc.claim('a'), svc.claim('b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(Object.keys(claims)).toHaveLength(1);
  });
});
