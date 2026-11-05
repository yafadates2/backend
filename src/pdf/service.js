import { loadFontCss } from './render.js';
import { renderDocument } from './templates.js';
import { LANGS } from './strings.js';
import { safeName } from './format.js';

export const FORMATS = ['a4', 'thermal'];
/** Which kinds may use the 80 mm roll; statements and reports are wide tables, A4 only. */
const THERMAL_OK = new Set(['bill', 'receipt']);

export class PdfRequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * data (pdf/data.js) -> templates -> renderer. Returns { bytes, filename }.
 * Bills stay printable after a client / supplier / product is archived, because everything printed comes
 * from the document's own snapshots plus the (never deleted) party record.
 */
export function createPdfService({ data, renderer, fonts = {}, logger }) {
  let fontCssPromise = null;
  const fontCss = () => {
    fontCssPromise ??= loadFontCss(fonts).catch((err) => { fontCssPromise = null; throw err; });
    return fontCssPromise;
  };

  async function make(doc, { lang = 'ar', format = 'a4', name }) {
    if (!LANGS.includes(lang)) throw new PdfRequestError('invalid_lang');
    if (!FORMATS.includes(format)) throw new PdfRequestError('invalid_format');
    if (format === 'thermal' && !THERMAL_OK.has(doc.kind)) throw new PdfRequestError('format_not_supported');
    const shop = await data.shop();
    const html = renderDocument(doc, { shop, lang, format, fontCss: await fontCss() });
    const bytes = await renderer.render(html, { format });
    logger?.info({ kind: doc.kind, format, bytes: bytes.length }, 'pdf generated');
    return { bytes, filename: `${safeName(name)}.pdf` };
  }

  return {
    async saleBill(id, o) { const d = await data.saleBill(id); return make(d, { ...o, name: d.number }); },
    async purchaseBill(id, o) { const d = await data.purchaseBill(id); return make(d, { ...o, name: d.number }); },
    async customerReceipt(id, o) { const d = await data.receipt('customer', id); return make(d, { ...o, name: d.number }); },
    async supplierReceipt(id, o) { const d = await data.receipt('supplier', id); return make(d, { ...o, name: d.number }); },
    async clientStatement(id, { from, to, ...o }) { const d = await data.statement('client', id, from, to); return make(d, { ...o, name: `statement-client-${from}_${to}` }); },
    async supplierStatement(id, { from, to, ...o }) { const d = await data.statement('supplier', id, from, to); return make(d, { ...o, name: `statement-supplier-${from}_${to}` }); },
    async expenseReport({ from, to, categoryId, ...o }) { const d = await data.expenseReport({ from, to, categoryId }); return make(d, { ...o, name: `expenses-${from}_${to}` }); },
    async salesReport({ from, to, ...o }) { const d = await data.salesReport({ from, to }); return make(d, { ...o, name: `sales-${from}_${to}` }); },
    async profitReport({ from, to, ...o }) { const d = await data.profitReport({ from, to }); return make(d, { ...o, name: `profit-${from}_${to}` }); },
  };
}
