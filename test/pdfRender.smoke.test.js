import { describe, it, expect } from 'vitest';
import { createPdfRenderer, loadFontCss } from '../src/pdf/render.js';
import { renderDocument } from '../src/pdf/templates.js';

// Needs `puppeteer` + a Chromium. Run with:  PDF_SMOKE=1 npm test -- pdfRender
const run = process.env.PDF_SMOKE === '1' ? describe : describe.skip;

run('real Chromium render', () => {
  const shop = { name: 'تمور يافا', phone: '20000000', address: 'تونس', logoDataUri: null, decimals: 3, symbol: 'د.ت' };
  const lines = Array.from({ length: 60 }, (_, i) => ({ name: `منتج رقم ${i + 1}`, qty: 2, unit: 6500, total: 13000 }));
  const doc = (n) => ({ kind: 'bill', variant: 'sale', number: 'TY-000123', dateText: '03/11/2026 13:05', party: { name: 'سالم', phone: '20111222', address: 'صفاقس' }, lines: lines.slice(0, n), subtotal: 13000 * n, discount: 0, extraCosts: 0, total: 13000 * n, paid: 0, remaining: 13000 * n, methodKey: 'credit', note: 'ملاحظة', voided: null });
  const pages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  it('A4 paginates long bills; thermal is one tall page; both are real PDFs', async () => {
    const fontCss = await loadFontCss();
    const renderer = createPdfRenderer({ timeoutMs: 60_000 });
    try {
      const a4 = await renderer.render(renderDocument(doc(60), { shop, lang: 'ar', format: 'a4', fontCss }), { format: 'a4' });
      const th = await renderer.render(renderDocument(doc(60), { shop, lang: 'ar', format: 'thermal', fontCss }), { format: 'thermal' });
      expect(a4.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pages(a4)).toBeGreaterThan(1);
      expect(th.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pages(th)).toBe(1);
    } finally {
      await renderer.close();
    }
  }, 90_000);
});
