import pino from 'pino';
import { loadConfig } from './config.js';
import { initAdmin, createTokenVerifier } from './firebase.js';
import { createImageStore } from './storage.js';
import { createMembershipService } from './membership.js';
import { createReferenceChecker } from './references.js';
import { FieldValue } from 'firebase-admin/firestore';
import { createSalesService } from './sales.js';
import { createPurchasesService } from './purchases.js';
import { createExpensesService } from './expenses.js';
import { createPdfDataService } from './pdf/data.js';
import { createPdfRenderer } from './pdf/render.js';
import { createPdfService } from './pdf/service.js';
import { createApp } from './app.js';

const logger = pino();
const cfg = loadConfig();
const { auth, db } = initAdmin(cfg);
const imageStore = createImageStore(cfg);
const renderer = createPdfRenderer({ logger });
const pdf = createPdfService({
  data: createPdfDataService({ db, imageStore, timeZone: cfg.PDF_TIMEZONE, logger }),
  renderer,
  fonts: { regular: cfg.PDF_FONT_REGULAR, bold: cfg.PDF_FONT_BOLD },
  logger,
});
const app = createApp({
  verifyToken: createTokenVerifier(auth),
  imageStore,
  membership: createMembershipService({ db, auth }),
  sales: createSalesService({ db, fieldValue: FieldValue }),
  purchases: createPurchasesService({ db, fieldValue: FieldValue }),
  expenses: createExpensesService({ db, fieldValue: FieldValue }),
  pdf,
  isReferenced: createReferenceChecker(db),
  logger,
});
const server = app.listen(cfg.PORT, () => logger.info(`API listening on :${cfg.PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); renderer.close().finally(() => process.exit(0)); }); // don't orphan Chromium
}
