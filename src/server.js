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
import { getMessaging } from 'firebase-admin/messaging';
import { createOrdersService } from './orders.js';
import { createNotifier } from './notifications.js';
import { startDailyReminders } from './reminders.js';
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
// Orders need the sales service (planSale); sales/purchases call back into orders when stock changes.
// The callback is fire-and-forget so a slow availability check never delays a sale or purchase.
const notifier = createNotifier({ db, messaging: getMessaging(), logger });
let orders;
const onStockChanged = (ids) => { orders?.checkProducts(ids).catch((err) => logger.error({ err }, 'availability check failed')); };
const sales = createSalesService({ db, fieldValue: FieldValue, onStockChanged });
orders = createOrdersService({ db, fieldValue: FieldValue, sales, notifier, logger });
const app = createApp({
  verifyToken: createTokenVerifier(auth),
  imageStore,
  membership: createMembershipService({ db, auth }),
  sales,
  purchases: createPurchasesService({ db, fieldValue: FieldValue, onStockChanged }),
  orders,
  notifier,
  expenses: createExpensesService({ db, fieldValue: FieldValue }),
  pdf,
  isReferenced: createReferenceChecker(db),
  logger,
});
const server = app.listen(cfg.PORT, () => logger.info(`API listening on :${cfg.PORT}`));
// 08:00 Africa/Tunis every day: "customer order expected today" pushes. Catches up right at start when the backend
// (re)starts after 08:00; every order is reminded once per expected date, so a restart can never repeat a push.
const reminders = startDailyReminders({ run: () => orders.sendDueReminders(), logger });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { reminders.stop(); server.close(); renderer.close().finally(() => process.exit(0)); }); // don't orphan Chromium
}
