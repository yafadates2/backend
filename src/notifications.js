import { createHash } from 'node:crypto';

const BAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const LANGS = ['ar', 'fr'];
const MAX_DEVICES = 50;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** Push texts per language. Kept short: the full details are one tap away in the app. */
export function availableMessage(lang, order) {
  const first = order.lines?.[0]?.productName ?? '';
  const more = (order.lines?.length ?? 0) > 1 ? ` +${order.lines.length - 1}` : '';
  if (lang === 'fr') {
    return {
      title: 'Commande client disponible',
      body: `${order.customerName} : ${first}${more} (${order.number})`,
    };
  }
  return {
    title: 'طلب زبون متوفر الآن',
    body: `${order.customerName}: ${first}${more} (${order.number})`,
  };
}

/**
 * Device tokens live in `device_tokens/{sha256(token)}` (Admin SDK only; the catch-all rule keeps apps out).
 * Only members can register (the route is behind requireMember), so every token belongs to shop staff.
 * `messaging` is firebase-admin's Messaging (injected so tests use a fake).
 */
export function createNotifier({ db, messaging, logger, now = () => Date.now() }) {
  const tokens = () => db.collection('device_tokens');

  return {
    async registerDevice(uid, { token, platform = 'android', lang = 'ar' }) {
      await tokens().doc(hashToken(token)).set({
        token, uid, platform, lang: LANGS.includes(lang) ? lang : 'ar', updatedAt: now(),
      });
      return { registered: true };
    },

    /** Only the device's owner may remove it (a token seen under another uid is left alone). */
    async unregisterDevice(uid, token) {
      const ref = tokens().doc(hashToken(token));
      const snap = await ref.get();
      if (snap.exists && snap.get('uid') === uid) await ref.delete();
      return { unregistered: true };
    },

    /** One push per device for this availability event; devices that no longer exist are pruned. */
    async orderAvailable(order) {
      const snap = await tokens().limit(MAX_DEVICES).get();
      const devices = snap.docs.map((d) => ({ id: d.id, token: d.get('token'), lang: d.get('lang') ?? 'ar' }));
      let sent = 0;
      for (const lang of LANGS) {
        const group = devices.filter((d) => (LANGS.includes(d.lang) ? d.lang : 'ar') === lang);
        if (!group.length) continue;
        const { title, body } = availableMessage(lang, order);
        const res = await messaging.sendEachForMulticast({
          tokens: group.map((d) => d.token),
          notification: { title, body },
          data: { type: 'customer_order_available', orderId: order.id },
          android: {
            priority: 'high',
            // tag: a newer push for the same order replaces the one still in the tray instead of stacking.
            notification: { channelId: 'customer_orders', tag: order.id },
          },
        });
        res.responses.forEach((r, i) => {
          if (r.success) { sent += 1; return; }
          if (BAD_TOKEN.has(r.error?.code)) {
            tokens().doc(group[i].id).delete().catch(() => {});
          } else {
            logger?.warn({ code: r.error?.code }, 'push failed for one device');
          }
        });
      }
      return { sent };
    },
  };
}
