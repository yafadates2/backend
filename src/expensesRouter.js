import { Router } from 'express';
import { z } from 'zod';
import { SalesError } from './salesMath.js';
import { MAX_EXPENSE_AMOUNT } from './expensesMath.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const docId = z.string().min(1).max(64).regex(/^[^/]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fields = {
  title: z.string().trim().min(1).max(80),
  amount: z.number().int().min(1).max(MAX_EXPENSE_AMOUNT),
  categoryId: docId,
  businessDate: date,
  description: z.string().max(300).default(''),
  attachmentKey: z.string().max(200).nullable().default(null),
};

export const expenseSchema = z.object({ expenseId: id, ...fields }).strict();
export const expenseUpdateSchema = z.object(fields).strict();
export const expenseArchiveSchema = z.object({ archived: z.boolean() }).strict();

/** Mounted at the app root; guards (auth, member, rate limit) are attached per route, never with router.use(). */
export function createExpensesRouter({ expenses, logger, guards }) {
  const router = Router();

  const run = (schema, handler, okStatus = 200) => async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    try {
      const out = await handler(req, parsed.data);
      res.status(out.duplicate ? 200 : okStatus).json(out);
    } catch (err) {
      if (err instanceof SalesError) return res.status(err.status).json({ error: err.message, code: err.code });
      logger?.error({ err }, 'expense operation failed');
      next(err);
    }
  };
  const withId = (schema, handler) => (req, res, next) => {
    if (!id.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    return run(schema, handler)(req, res, next);
  };

  router.post('/expenses', ...guards, run(expenseSchema, (req, d) => expenses.createExpense(req.user.uid, d), 201));
  router.post('/expenses/:id/update', ...guards, withId(expenseUpdateSchema, (req, d) => expenses.updateExpense(req.user.uid, req.params.id, d)));
  router.post('/expenses/:id/archive', ...guards, withId(expenseArchiveSchema, (req, d) => expenses.setArchived(req.user.uid, req.params.id, d.archived)));
  return router;
}
