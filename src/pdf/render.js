import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @font-face rules with the font files inlined (data: URIs), so the PDF never depends on system fonts. */
export async function loadFontCss({ regular, bold, baseDir = backendDir } = {}) {
  const reg = path.resolve(baseDir, regular || 'assets/fonts/DejaVuSans.ttf');
  const bld = path.resolve(baseDir, bold || 'assets/fonts/DejaVuSans-Bold.ttf');
  const face = async (file, weight) =>
    `@font-face{font-family:'PDFFont';font-weight:${weight};src:url(data:font/ttf;base64,${(await readFile(file)).toString('base64')}) format('truetype')}`;
  return `${await face(reg, 'normal')}${await face(bld, 'bold')}`;
}

export function defaultLaunch(env = process.env) {
  return async () => {
    const { default: puppeteer } = await import('puppeteer'); // loaded lazily: tests and non-PDF routes never need it
    return puppeteer.launch({
      headless: true,
      executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--disable-gpu', '--disable-dev-shm-usage',
        // Hosting containers (Render sets RENDER=true) run as root without user namespaces, where Chromium's sandbox
        // cannot start. Safe here: the page runs no scripts (CSP) and every non-data: request is aborted.
        ...(env.PDF_NO_SANDBOX === '1' || env.RENDER === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      ],
    });
  };
}

export class PdfRenderError extends Error {
  constructor(message, code = 'pdf_failed') {
    super(message);
    this.code = code;
    this.status = code === 'pdf_busy' ? 503 : 500;
  }
}

const FOOTER = '<div style="font-size:8px;width:100%;text-align:center;color:#777"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/**
 * One shared headless Chromium, at most `maxConcurrent` pages rendering at once (the rest wait, up to
 * `maxQueue`, then get `pdf_busy`). The page can run no scripts (CSP in the HTML) and every request except
 * data: URLs is aborted, so document text can never make the server fetch anything.
 */
export function createPdfRenderer({ launch = defaultLaunch(), logger, maxConcurrent = 2, maxQueue = 8, timeoutMs = 30_000 } = {}) {
  let browserPromise = null;
  let active = 0;
  const waiters = [];

  const getBrowser = () => {
    if (!browserPromise) {
      const p = launch();
      browserPromise = p;
      p.then((b) => b.on?.('disconnected', () => { if (browserPromise === p) browserPromise = null; }))
        .catch(() => { if (browserPromise === p) browserPromise = null; });
    }
    return browserPromise;
  };

  const acquire = async () => {
    if (active < maxConcurrent) { active += 1; return; }
    if (waiters.length >= maxQueue) throw new PdfRenderError('Too many PDFs in progress', 'pdf_busy');
    await new Promise((resolve) => waiters.push(resolve));
  };
  const release = () => {
    const next = waiters.shift();
    if (next) next(); else active -= 1;
  };

  async function renderOnce(html, format) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setRequestInterception(true);
      page.on('request', (r) => (r.url().startsWith('data:') ? r.continue() : r.abort()));
      await page.setViewport({ width: format === 'thermal' ? 302 : 794, height: 1000 });
      await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
      await page.evaluate(() => document.fonts.ready);
      if (format === 'thermal') {
        // 80 mm roll: fixed width, height = the content (a receipt printer cuts after the last line).
        const px = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
        return await page.pdf({ width: '80mm', height: `${px + 8}px`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, pageRanges: '1' });
      }
      return await page.pdf({
        format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: FOOTER,
        margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
      });
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    /** html -> Buffer (PDF). format: 'a4' | 'thermal'. */
    async render(html, { format = 'a4' } = {}) {
      await acquire();
      let timer;
      try {
        const bytes = await Promise.race([
          renderOnce(html, format),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new PdfRenderError('PDF timed out', 'pdf_timeout')), timeoutMs); }),
        ]);
        return Buffer.from(bytes);
      } catch (err) {
        logger?.error({ err }, 'pdf render failed');
        if (err instanceof PdfRenderError) throw err;
        throw new PdfRenderError('PDF generation failed');
      } finally {
        clearTimeout(timer);
        release();
      }
    },
    async close() {
      const p = browserPromise;
      browserPromise = null;
      if (p) await (await p.catch(() => null))?.close().catch(() => {});
    },
  };
}
