import { Router } from 'express';
import { z } from 'zod';
import { SalesError, MAX_LINES } from './salesMath.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/); // `ord_<id>` becomes the sale id (max 64)
const docId = z.string().min(1).max(64).regex(/^[^/]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phone = z.string().regex(/^\+?[0-9]{6,15}$/);
const name = z.string().trim().min(1).max(80);

export const orderSchema = z.object({
  orderId: id,
  customerName: name,
  customerPhone: phone,
  lines: z.array(z.object({
    productId: docId,
    qty: z.number().int().min(1).max(100_000),
    unitPrice: z.number().int().min(0).max(100_000_000).optional(),
  }).strict()).min(1).max(MAX_LINES),
  expectedDate: date.nullish(),
  notes: z.string().max(500).default(''),
}).strict();

export const patchSchema = z.object({
  customerName: name.optional(),
  customerPhone: phone.optional(),
  expectedDate: date.nullable().optional(),
  notes: z.string().max(500).optional(),
}).strict();

export const completeSchema = z.object({ businessDate: date }).strict();
export const cancelSchema = z.object({ reason: z.string().max(200).default('') }).strict();
export const checkSchema = z.object({ productIds: z.array(docId).max(50).optional() }).strict();
export const deviceSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(['android', 'ios']).default('android'),
  lang: z.enum(['ar', 'fr']).default('ar'),
}).strict();
export const removeDeviceSchema = z.object({ token: z.string().min(20).max(4096) }).strict();

/**
 * Customer orders + device registration. Mounted at the app root; `guards` (auth, member, rate limit) are
 * attached per route, never with router.use(). Errors carry stable codes for the app.
 */
export function createOrdersRouter({ orders, notifier, logger, guards }) {
  const router = Router();

  const run = (schema, handler, okStatus = 200) => async (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    try {
      const out = await handler(req, parsed.data);
      res.status(out.duplicate ? 200 : okStatus).json(out);
    } catch (err) {
      if (err instanceof SalesError) return res.status(err.status).json({ error: err.message, code: err.code });
      logger?.error({ err }, 'customer order operation failed');
      next(err);
    }
  };
  const withId = (schema, handler) => (req, res, next) => {
    if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    return run(schema, (r, d) => handler(r, req.params.id, d))(req, res, next);
  };
  const none = z.object({}).strict();

  router.post('/customer-orders', ...guards, run(orderSchema, (req, d) => orders.createOrder(req.user.uid, d), 201));
  // Static path: registered before nothing that could shadow it (all `:id` routes have a second segment).
  router.post('/customer-orders/check-availability', ...guards,
    run(checkSchema, (_req, d) => (d.productIds?.length ? orders.checkProducts(d.productIds) : orders.checkAll())));
  router.patch('/customer-orders/:id', ...guards, withId(patchSchema, (req, oid, d) => orders.updateOrder(req.user.uid, oid, d)));
  router.post('/customer-orders/:id/notified', ...guards, withId(none, (req, oid) => orders.markNotified(req.user.uid, oid)));
  router.post('/customer-orders/:id/complete', ...guards, withId(completeSchema, (req, oid, d) => orders.completeOrder(req.user.uid, oid, d)));
  router.post('/customer-orders/:id/cancel', ...guards, withId(cancelSchema, (req, oid, d) => orders.cancelOrder(req.user.uid, oid, d)));

  router.put('/devices', ...guards, run(deviceSchema, (req, d) => notifier.registerDevice(req.user.uid, d)));
  router.post('/devices/unregister', ...guards, run(removeDeviceSchema, (req, d) => notifier.unregisterDevice(req.user.uid, d.token)));
  return router;
}
