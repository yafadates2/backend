import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { MembershipError } from './membership.js';
import { createImagesRouter } from './images.js';
import { createSalesRouter } from './salesRouter.js';
import { createPurchasesRouter } from './purchasesRouter.js';
import { createExpensesRouter } from './expensesRouter.js';
import { createPdfRouter } from './pdf/router.js';
import { createOrdersRouter } from './ordersRouter.js';

// isReferenced defaults to "yes, in use" so a missing wiring can never delete an image.
export function createApp({ verifyToken, imageStore, membership, logger, sales, purchases, expenses, pdf, orders, notifier, isReferenced = async () => true }) {
  const app = express();
  // Behind a hosting proxy (Render puts exactly one in front) every request arrives from the proxy's address.
  // Trusting one hop makes req.ip the real client, so the rate limiters count each client separately instead of
  // lumping everybody together, and express-rate-limit stops reporting ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '64kb' })); // a 50-line cart is ~5 KB
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));
  // Invite codes must not be brute-forceable.
  const claimLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  const requireAuth = async (req, res, next) => {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing bearer token' });
    try {
      req.user = await verifyToken(token);
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
  // Signing up is open at the Firebase level; only the backend grants `member` (invite flow).
  const requireMember = (req, res, next) =>
    req.user.member === true ? next() : res.status(403).json({ error: 'Members only', code: 'not_member' });
  const requireOwner = (req, res, next) =>
    req.user.owner === true ? next() : res.status(403).json({ error: 'Owner only' });

  const fail = (err, res, next) =>
    err instanceof MembershipError ? res.status(err.status).json({ error: err.message, code: err.code }) : next(err);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/me', requireAuth, (req, res) =>
    res.json({ uid: req.user.uid, email: req.user.email ?? null }));

  app.get('/health/storage', requireAuth, requireMember, async (_req, res) => {
    try {
      res.json(await imageStore.selfTest());
    } catch (err) {
      logger.error({ err }, 'storage self-test failed');
      res.status(502).json({ error: 'Storage unavailable' });
    }
  });

  const imageWriteLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const imageReadLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });
  app.use('/images', requireAuth, requireMember,
    createImagesRouter({ imageStore, isReferenced, logger, limiters: { write: imageWriteLimiter, read: imageReadLimiter } }));

  // Sales, customer payments, voids: the only writer of these collections (rules keep them read-only for apps).
  if (sales) {
    const salesLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
    app.use(createSalesRouter({ sales, logger, guards: [requireAuth, requireMember, salesLimiter] }));
  }

  // Purchases, supplier payments, purchase voids: the only writer of these collections (read-only for apps).
  if (purchases) {
    const purchasesLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
    app.use(createPurchasesRouter({ purchases, logger, guards: [requireAuth, requireMember, purchasesLimiter] }));
  }

  // Expenses: the only writer of `expenses` (read-only for apps) so daily_stats stays consistent.
  if (expenses) {
    const expensesLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
    app.use(createExpensesRouter({ expenses, logger, guards: [requireAuth, requireMember, expensesLimiter] }));
  }

  // Customer orders (requests recorded by the admin; stock moves only when one is completed) and push-device registration.
  if (orders && notifier) {
    const ordersLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
    app.use(createOrdersRouter({ orders, notifier, logger, guards: [requireAuth, requireMember, ordersLimiter] }));
  }

  // PDF documents (bills, receipts, statements, reports): read-only GETs; Chromium is heavy, so a tighter limit.
  if (pdf) {
    const pdfLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
    app.use(createPdfRouter({ pdf, logger, guards: [requireAuth, requireMember, pdfLimiter] }));
  }

  app.post('/auth/claim', claimLimiter, requireAuth, async (req, res, next) => {
    const code = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode : undefined;
    try {
      res.json(await membership.claim(req.user.uid, code));
    } catch (err) {
      fail(err, res, next);
    }
  });

  app.post('/invites', requireAuth, requireOwner, async (req, res, next) => {
    try {
      res.status(201).json(await membership.createInvite(req.user.uid));
    } catch (err) {
      fail(err, res, next);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}
