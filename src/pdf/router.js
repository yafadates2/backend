import { Router } from 'express';
import { z } from 'zod';
import { PdfDataError } from './data.js';
import { PdfRequestError, FORMATS } from './service.js';
import { PdfRenderError } from './render.js';
import { LANGS } from './strings.js';

const docId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const common = {
  lang: z.enum(LANGS).default('ar'),
  format: z.enum(FORMATS).default('a4'),
};
const period = z.object({ ...common, from: date, to: date }).strict();
const billQuery = z.object(common).strict();

/**
 * GET /pdf/... -> application/pdf. Read-only: nothing is written anywhere.
 * Mounted at the app root; `guards` (auth, member, rate limit) are attached per route like the other routers.
 */
export function createPdfRouter({ pdf, logger, guards }) {
  const router = Router();

  const send = (handler, schema) => async (req, res, next) => {
    const id = req.params.id;
    if (id !== undefined && !docId.safeParse(id).success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    const q = schema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'Invalid request', code: 'invalid_request' });
    try {
      const { bytes, filename } = await handler(id, q.data);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store', // financial documents: never cached by proxies / the browser
      });
      res.status(200).end(bytes);
    } catch (err) {
      if (err instanceof PdfDataError || err instanceof PdfRequestError || err instanceof PdfRenderError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      logger?.error({ err }, 'pdf request failed');
      next(err);
    }
  };

  router.get('/pdf/sales/:id', ...guards, send((id, q) => pdf.saleBill(id, q), billQuery));
  router.get('/pdf/purchases/:id', ...guards, send((id, q) => pdf.purchaseBill(id, q), billQuery));
  router.get('/pdf/customer-payments/:id', ...guards, send((id, q) => pdf.customerReceipt(id, q), billQuery));
  router.get('/pdf/supplier-payments/:id', ...guards, send((id, q) => pdf.supplierReceipt(id, q), billQuery));
  router.get('/pdf/clients/:id/statement', ...guards, send((id, q) => pdf.clientStatement(id, q), period));
  router.get('/pdf/suppliers/:id/statement', ...guards, send((id, q) => pdf.supplierStatement(id, q), period));
  router.get('/pdf/reports/sales', ...guards, send((_id, q) => pdf.salesReport(q), period));
  router.get('/pdf/reports/profit', ...guards, send((_id, q) => pdf.profitReport(q), period));
  router.get('/pdf/reports/expenses', ...guards,
    send((_id, q) => pdf.expenseReport(q), period.extend({ categoryId: docId.optional() }).strict()));
  return router;
}
