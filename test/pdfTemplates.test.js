import { describe, it, expect } from 'vitest';
import { renderDocument } from '../src/pdf/templates.js';

const shop = { name: 'تمور يافا', phone: '+216 20 000 000', address: 'تونس', logoDataUri: null, decimals: 3, symbol: 'د.ت' };
const fontCss = '@font-face{font-family:PDFFont;src:local(x)}';
const render = (doc, o = {}) => renderDocument(doc, { shop, lang: 'ar', format: 'a4', fontCss, ...o });

const bill = (over = {}) => ({
  kind: 'bill', variant: 'sale', number: 'TY-000123', dateText: '03/11/2026 13:05',
  party: { name: 'سالم', phone: '20111222', address: 'صفاقس' },
  lines: [{ name: 'رب 250غ', qty: 2, unit: 6500, total: 13000 }, { name: 'دهان 250غ', qty: 1, unit: 17000, total: 17000 }],
  subtotal: 30000, discount: 1000, extraCosts: 0, total: 29000, paid: 20000, remaining: 9000, methodKey: 'both', note: '', voided: null, ...over,
});

describe('bill', () => {
  it('has RTL page, shop, number, items, totals, remaining and method', () => {
    const h = render(bill());
    expect(h).toContain('dir="rtl"');
    expect(h).toContain('تمور يافا');
    expect(h).toContain('فاتورة بيع');
    expect(h).toContain('<span class="ltr">TY-000123</span>');
    expect(h).toContain('رب 250غ');
    expect(h).toContain('<span class="ltr">29.000</span> د.ت');
    expect(h).toContain('المتبقي');
    expect(h).toContain('نقدًا + آجل');
    expect(h).toContain('التخفيض');
  });
  it('hides discount and remaining when zero', () => {
    const h = render(bill({ discount: 0, remaining: 0, methodKey: 'cash' }));
    expect(h).not.toContain('التخفيض');
    expect(h).not.toContain('class="r due"');
    expect(h).toContain('نقدًا');
  });
  it('escapes names and notes (no markup injection)', () => {
    const h = render(bill({ party: { name: '<script>alert(1)</script>', phone: '', address: '' }, note: '"><img src=x>' }));
    expect(h).not.toContain('<script>alert');
    expect(h).not.toContain('<img src=x>');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('locks scripts and network with a CSP', () => {
    expect(render(bill())).toContain("default-src 'none'");
  });
  it('marks voided bills with a watermark and the reason', () => {
    const h = render(bill({ voided: { reason: 'خطأ في الكمية' } }));
    expect(h).toContain('class="wm"');
    expect(h).toContain('خطأ في الكمية');
  });
  it('walk-in sales name the walk-in client', () => {
    expect(render(bill({ party: null }))).toContain('عميل عابر');
  });
  it('thermal uses compact item rows, not a table', () => {
    const h = render(bill(), { format: 'thermal' });
    expect(h).toContain('class="thermal"');
    expect(h).toContain('class="item"');
    expect(h).not.toContain('<table');
  });
  it('purchase bills show supplier invoice ref and extra costs', () => {
    const h = render(bill({ variant: 'purchase', invoiceRef: 'F-77', extraCosts: 2000, party: { name: 'مورد', phone: '', address: '' } }));
    expect(h).toContain('فاتورة شراء');
    expect(h).toContain('F-77');
    expect(h).toContain('مصاريف إضافية');
    expect(h).toContain('سعر الشراء');
  });
  it('French is left-to-right with French labels', () => {
    const h = render(bill(), { lang: 'fr' });
    expect(h).toContain('dir="ltr"');
    expect(h).toContain('Facture de vente');
    expect(h).toContain('Reste à payer');
  });
});

describe('receipt, statement, reports', () => {
  it('receipt lists settled invoices and balance', () => {
    const h = render({
      kind: 'receipt', variant: 'customer', number: 'TY-R-000001', dateText: '03/11/2026', party: { name: 'سالم', phone: '', address: '' },
      amount: 15000, allocations: [{ number: 'TY-000001', amount: 10000 }, { number: 'TY-000002', amount: 5000 }], balanceNow: 3000, note: '',
    });
    expect(h).toContain('وصل استلام دفعة');
    expect(h).toContain('TY-000002');
    expect(h).toContain('الفواتير المسدّدة');
  });
  it('statement shows opening, rows with running balance and closing', () => {
    const h = render({
      kind: 'statement', variant: 'client', party: { name: 'سالم', phone: '', address: '' }, fromText: '01/11/2026', toText: '30/11/2026',
      opening: 5000, closing: 8000, balanceNow: 8000, generatedText: '03/11/2026 13:05',
      rows: [{ dateText: '02/11/2026', labelKey: 'saleEntry', ref: 'TY-000001', debit: 10000, credit: 0, balance: 15000 },
        { dateText: '03/11/2026', labelKey: 'paymentEntry', ref: 'TY-R-000001', debit: 0, credit: 7000, balance: 8000 }],
    });
    expect(h).toContain('كشف حساب العميل');
    expect(h).toContain('الرصيد السابق');
    expect(h).toContain('دفعة');
    expect(h).toContain('<span class="ltr">8.000</span>');
  });
  it('expense report has totals per category and the table', () => {
    const h = render({
      kind: 'expenseReport', fromText: '01/11/2026', toText: '30/11/2026', categoryName: null, total: 3000, count: 2, truncated: true, generatedText: '',
      byCategory: [{ name: 'كراء', count: 1, total: 2000 }, { name: 'ماء', count: 1, total: 1000 }],
      rows: [{ dateText: '02/11/2026', number: 'TY-E-000001', title: 'كراء نوفمبر', categoryName: 'كراء', amount: 2000 },
        { dateText: '03/11/2026', number: 'TY-E-000002', title: 'فاتورة الماء', categoryName: 'ماء', amount: 1000 }],
    });
    expect(h).toContain('تقرير المصاريف');
    expect(h).toContain('كل الفئات');
    expect(h).toContain('القائمة مقتطعة');
    expect(h).toContain('TY-E-000002');
  });
  it('sales report shows days, totals and the invoice list with voided badge', () => {
    const t = { salesCount: 2, gross: 30000, voided: 10000, net: 20000, cash: 20000, credit: 10000, payments: 4000, profit: 7000 };
    const h = render({
      kind: 'salesReport', fromText: '01/11/2026', toText: '03/11/2026', generatedText: '', truncated: false, totals: t,
      days: [{ dateText: '03/11/2026', salesCount: 2, gross: 30000, voided: 10000, net: 20000, cash: 20000, credit: 10000, payments: 4000, profit: 7000 }],
      sales: [{ dateText: '03/11/2026', number: 'TY-000002', clientName: '', total: 10000, paid: 0, voided: true }],
    });
    expect(h).toContain('تقرير المبيعات');
    expect(h).toContain('صافي المبيعات');
    expect(h).toContain('class="badge"');
  });
  it('rejects unknown kinds', () => {
    expect(() => render({ kind: 'nope' })).toThrow();
  });
});

describe('profit report', () => {
  const t = { gross: 25000, voided: 12000, net: 13000, cogs: 8000, discounts: 1000, grossProfit: 5000, expenses: 2500, netProfit: 2500, cashIn: 13000, credit: 3000, purchases: 50000, supplierPaid: 0 };
  const doc = { kind: 'profitReport', fromText: '01/11/2026', toText: '30/11/2026', generatedText: '', totals: t, days: [{ dateText: '03/11/2026', net: 13000, grossProfit: 5000, expenses: 2500, netProfit: 2500 }] };
  it('shows the statement, net profit and the cost note (Arabic and French)', () => {
    const ar = render(doc);
    expect(ar).toContain('تقرير الأرباح والخسائر');
    expect(ar).toContain('صافي الربح');
    expect(ar).toContain('<span class="ltr">2.500</span> د.ت');
    expect(ar).toContain('تكلفة صفر');
    const fr = render(doc, { lang: 'fr' });
    expect(fr).toContain('Rapport de résultat');
    expect(fr).toContain('Bénéfice net');
  });
  it('empty period shows the no-data line', () => {
    expect(render({ ...doc, days: [] })).toContain('لا توجد بيانات');
  });
});
