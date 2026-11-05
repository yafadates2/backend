import { Router } from 'express';
import { z } from 'zod';
import { SalesError, MAX_LINES } from './salesMath.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const docId = z.string().min(1).max(64).regex(/^[^/]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().int().min(0).max(100_000_000_000);

export const purchaseSchema = z.object({
  purchaseId: id,
  supplierId: docId,
  invoiceRef: z.string().max(40).default(''),
  businessDate: date,
  lines: z.array(z.object({
    productId: docId,
    qty: z.number().int().min(1).max(100_000),
    unitCost: z.number().int().min(0).max(100_000_000),
  }).strict()).min(1).max(MAX_LINES),
  discount: money.default(0),
  extraCosts: money.default(0),
  cashPaid: money,
  note: z.string().max(200).default(''),
}).strict();

export const purchaseVoidSchema = z.object({
  businessDate: date,
  reason: z.string().max(200).default(''),
}).strict();

export const supplierPaymentSchema = z.object({
  paymentId: id,
  supplierId: docId,
  amount: z.number().int().min(1).max(100_000_000_000),
  businessDate: date,
  note: z.string().max(200).default(''),
}).strict();

/** Mounted at the app root; guards (auth, member, rate limit) are attached per route, never with router.use(). */
export function createPurchasesRouter({ purchases, logger, guards }) {
  const router = Router();

  const run = (schema, handler, okStatus = 200) => async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    try {
      const out = await handler(req, parsed.data);
      res.status(out.duplicate ? 200 : okStatus).json(out);
    } catch (err) {
      if (err instanceof SalesError) return res.status(err.status).json({ error: err.message, code: err.code });
      logger?.error({ err }, 'purchase operation failed');
      next(err);
    }
  };

  router.post('/purchases', ...guards, run(purchaseSchema, (req, d) => purchases.createPurchase(req.user.uid, d), 201));
  router.post('/purchases/:id/void', ...guards, async (req, res, next) => {
    if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    return run(purchaseVoidSchema, (r, d) => purchases.voidPurchase(r.user.uid, req.params.id, d))(req, res, next);
  });
  router.post('/payments/supplier', ...guards, run(supplierPaymentSchema, (req, d) => purchases.paySupplier(req.user.uid, d), 201));
  return router;
}
