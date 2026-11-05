import { createHash, randomBytes } from 'node:crypto';

// 32 symbols, no 0/O/1/I -> 256 % 32 === 0, so the modulo below is unbiased.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export class MembershipError extends Error {
  constructor(message, status = 400, code = 'membership_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const hashCode = (code) =>
  createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');

export function generateCode(length = 10, bytes = randomBytes) {
  return Array.from(bytes(length), (b) => ALPHABET[b % 32]).join('');
}

/**
 * First account to claim becomes the owner (atomic, via a Firestore transaction).
 * Every later account needs a single-use, expiring invite code created by the owner.
 * Claims `member` (and `owner`) are written with the Admin SDK; clients can't forge them.
 */
export function createMembershipService({ db, auth, now = () => Date.now() }) {
  const ownerRef = db.collection('system').doc('owner');
  const invites = db.collection('invites');
  const grant = (uid, owner) =>
    auth.setCustomUserClaims(uid, { member: true, ...(owner ? { owner: true } : {}) });

  return {
    async claim(uid, inviteCode) {
      const outcome = await db.runTransaction(async (tx) => {
        const ownerSnap = await tx.get(ownerRef);
        if (!ownerSnap.exists) {
          tx.create(ownerRef, { uid, createdAt: now() });
          return { owner: true };
        }
        if (ownerSnap.get('uid') === uid) return { owner: true }; // idempotent re-claim
        if (!inviteCode) throw new MembershipError('An invite code is required', 403, 'invite_required');

        const ref = invites.doc(hashCode(inviteCode));
        const snap = await tx.get(ref);
        if (!snap.exists) throw new MembershipError('Invalid invite code', 403, 'invite_invalid');
        const inv = snap.data();
        if (inv.usedBy && inv.usedBy !== uid) throw new MembershipError('Invite code already used', 403, 'invite_used');
        if (!inv.usedBy) {
          if (inv.expiresAt <= now()) throw new MembershipError('Invite code expired', 403, 'invite_expired');
          tx.update(ref, { usedBy: uid, usedAt: now() });
        }
        return { owner: false };
      });
      await grant(uid, outcome.owner); // retry-safe: re-claiming re-applies the claims
      return { role: outcome.owner ? 'owner' : 'member' };
    },

    async createInvite(ownerUid) {
      const code = generateCode();
      const createdAt = now();
      const expiresAt = createdAt + INVITE_TTL_MS;
      await invites.doc(hashCode(code)).create({ createdBy: ownerUid, createdAt, expiresAt, usedBy: null });
      return { code, expiresAt };
    },
  };
}
