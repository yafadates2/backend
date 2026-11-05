import { Router } from 'express';
import { z } from 'zod';
import { SalesError, MAX_LINES } from './salesMath.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const docId = z.string().min(1).max(64).regex(/^[^/]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().int().min(0).max(100_000_000_000);

export const saleSchema = z.object({
  saleId: id,
  clientId: docId.nullish(),
  businessDate: date,
  lines: z.array(z.object({
    productId: docId,
    qty: z.number().int().min(1).max(100_000),
    unitPrice: z.number().int().min(0).max(100_000_000).optional(),
  }).strict()).min(1).max(MAX_LINES),
  discount: money.default(0),
  cashPaid: money,
  note: z.string().max(200).default(''),
}).strict();

export const voidSchema = z.object({
  businessDate: date,
  reason: z.string().max(200).default(''),
}).strict();

export const paymentSchema = z.object({
  paymentId: id,
  clientId: docId,
  amount: z.number().int().min(1).max(100_000_000_000),
  businessDate: date,
  note: z.string().max(200).default(''),
}).strict();

/**
 * Mounted at the app root. `guards` (auth, member, rate limit) are attached per route, never with
 * router.use(), so they cannot leak onto unrelated routes such as /auth/claim.
 * Errors carry stable codes for the app.
 */
export function createSalesRouter({ sales, logger, guards }) {
  const router = Router();

  const run = (schema, handler, okStatus = 200) => async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    try {
      const out = await handler(req, parsed.data);
      res.status(out.duplicate ? 200 : okStatus).json(out);
    } catch (err) {
      if (err instanceof SalesError) return res.status(err.status).json({ error: err.message, code: err.code });
      logger?.error({ err }, 'sales operation failed');
      next(err);
    }
  };

  router.post('/sales', ...guards, run(saleSchema, (req, d) => sales.createSale(req.user.uid, d), 201));
  router.post('/sales/:id/void', ...guards, async (req, res, next) => {
    if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    return run(voidSchema, (r, d) => sales.voidSale(r.user.uid, req.params.id, d))(req, res, next);
  });
  router.post('/payments/customer', ...guards, run(paymentSchema, (req, d) => sales.receivePayment(req.user.uid, d), 201));
  return router;
}
