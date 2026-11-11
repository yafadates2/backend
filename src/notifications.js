import { createHash } from 'node:crypto';

const BAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const LANGS = ['ar', 'fr'];
const MAX_DEVICES = 50;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** "Customer: first product +N (number)": shared by every order push. */
function orderBody(lang, order) {
  const first = order.lines?.[0]?.productName ?? '';
  const more = (order.lines?.length ?? 0) > 1 ? ` +${order.lines.length - 1}` : '';
  return `${order.customerName}${lang === 'fr' ? ' :' : ':'} ${first}${more} (${order.number})`;
}

/** Push texts per language. Kept short: the full details are one tap away in the app. */
export function availableMessage(lang, order) {
  return {
    title: lang === 'fr' ? 'Commande client disponible' : 'طلب زبون متوفر الآن',
    body: orderBody(lang, order),
  };
}

/** Reminder sent in the morning of an order's expected date (whatever its stock situation is). */
export function expectedTodayMessage(lang, order) {
  return {
    title: lang === 'fr' ? 'Commande client prévue aujourd’hui' : 'موعد طلب زبون اليوم',
    body: orderBody(lang, order),
  };
}

/**
 * Device tokens live in `device_tokens/{sha256(token)}` (Admin SDK only; the catch-all rule keeps apps out).
 * Only members can register (the route is behind requireMember), so every token belongs to shop staff.
 * `messaging` is firebase-admin's Messaging (injected so tests use a fake).
 */
export function createNotifier({ db, messaging, logger, now = () => Date.now() }) {
  const tokens = () => db.collection('device_tokens');

  /** Sends one push per device, grouped by language. Devices that no longer exist are pruned. */
  async function broadcast(order, { messageFor, data, tag, tolerant = false }) {
    const snap = await tokens().limit(MAX_DEVICES).get();
    const devices = snap.docs.map((d) => ({ id: d.id, token: d.get('token'), lang: d.get('lang') ?? 'ar' }));
    let sent = 0;
    for (const lang of LANGS) {
      const group = devices.filter((d) => (LANGS.includes(d.lang) ? d.lang : 'ar') === lang);
      if (!group.length) continue;
      const { title, body } = messageFor(lang, order);
      let res;
      try {
        res = await messaging.sendEachForMulticast({
          tokens: group.map((d) => d.token),
          notification: { title, body },
          data,
          android: {
            priority: 'high',
            // tag: a newer push for the same order replaces the one still in the tray instead of stacking.
            notification: { channelId: 'customer_orders', tag },
          },
        });
      } catch (err) {
        if (!tolerant) throw err;
        logger?.warn({ err }, 'push failed for a language group');
        continue;
      }
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
  }

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
    orderAvailable(order) {
      return broadcast(order, {
        messageFor: availableMessage,
        data: { type: 'customer_order_available', orderId: order.id },
        tag: order.id,
      });
    },

    /**
     * One push per device: "this order is expected today". Its own type (the app handles it separately) and its
     * own tray tag (it never replaces the "available" notification of the same order). A failing language group
     * is logged and skipped instead of thrown, so `sent` is always the exact number of devices reached and the
     * caller can decide on a retry without ever re-sending to devices that already got it.
     */
    orderExpectedToday(order) {
      return broadcast(order, {
        messageFor: expectedTodayMessage,
        data: { type: 'customer_order_expected_today', orderId: order.id, expectedDate: String(order.expectedDate ?? '') },
        tag: `${order.id}:expected`,
        tolerant: true,
      });
    },
  };
}
