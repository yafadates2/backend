import { escapeHtml as e, formatMoney } from './format.js';
import { stringsFor } from './strings.js';

/**
 * Pure HTML builders: model in, HTML string out (no I/O), so they are unit-tested without a browser.
 * Rules: every dynamic value is escaped; numbers / ids / dates are wrapped in an LTR isolate so Arabic
 * (RTL) text never reorders them (e.g. 2026-11-03 would otherwise display as 03-11-2026).
 */
const ltr = (v) => `<span class="ltr">${e(v)}</span>`;

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'PDFFont',sans-serif;color:#1d1b16;font-size:11.5px;line-height:1.5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ltr{direction:ltr;unicode-bidi:isolate;display:inline-block}
.page{position:relative;padding:0}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #7a4b1c;padding-bottom:10px;margin-bottom:12px}
.shop{display:flex;gap:10px;align-items:center}
.shop img{width:62px;height:62px;object-fit:contain}
.shop .name{font-size:18px;font-weight:bold;color:#7a4b1c}
.muted{color:#6b665c}
.doc{text-align:end}
.doc .title{font-size:17px;font-weight:bold}
.box{border:1px solid #d9d2c3;border-radius:6px;padding:8px 10px;margin-bottom:12px}
.box .k{color:#6b665c}
table{width:100%;border-collapse:collapse}
thead{display:table-header-group}
tr{page-break-inside:avoid}
th{background:#f1ebdd;font-weight:bold;text-align:start;padding:6px 8px;border-bottom:1px solid #cfc6b3}
td{padding:5px 8px;border-bottom:1px solid #ece6d8;vertical-align:top}
td.num,th.num{text-align:end;white-space:nowrap}
tr.b td{font-weight:bold;background:#faf7ef}
tfoot td{font-weight:bold;border-top:2px solid #cfc6b3;border-bottom:0}
.totals{margin-top:12px;margin-inline-start:auto;width:55%}
.totals .r{display:flex;justify-content:space-between;padding:3px 0}
.totals .grand{font-size:14px;font-weight:bold;border-top:2px solid #7a4b1c;margin-top:4px;padding-top:6px}
.totals .due{font-weight:bold;color:#a12b1f}
.note{margin-top:12px;padding:8px 10px;background:#faf7ef;border-radius:6px}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;background:#f6d9d5;color:#a12b1f;font-weight:bold}
.wm{position:fixed;top:38%;inset-inline:0;text-align:center;font-size:96px;font-weight:bold;color:rgba(161,43,31,.14);transform:rotate(-24deg);pointer-events:none}
.foot{margin-top:18px;text-align:center;color:#6b665c;font-size:10px}
.cards{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.card{flex:1 1 140px;border:1px solid #d9d2c3;border-radius:6px;padding:8px 10px}
.card .v{font-size:14px;font-weight:bold}
h3{font-size:13px;margin:14px 0 6px;color:#7a4b1c}
/* 80 mm thermal paper */
body.thermal{font-size:11px;line-height:1.4;width:80mm;padding:3mm 3.5mm}
.thermal header.top{display:block;text-align:center;border-bottom:1px dashed #000;padding-bottom:6px}
.thermal .shop{justify-content:center;flex-direction:column;gap:2px}
.thermal .shop img{width:44px;height:44px}
.thermal .doc{text-align:center;margin-top:4px}
.thermal .box{border:0;border-bottom:1px dashed #000;border-radius:0;padding:4px 0}
.thermal .item{border-bottom:1px dotted #999;padding:3px 0}
.thermal .item .l2{display:flex;justify-content:space-between}
.thermal .totals{width:100%}
.thermal .wm{font-size:44px;top:30%}
.thermal .note{background:none;border-top:1px dashed #000;border-radius:0;padding:4px 0}
`;

export function documentShell({ lang, format, fontCss, body, title }) {
  const s = stringsFor(lang);
  // CSP: no scripts, no network; only inline CSS, data: fonts and data: images (the logo).
  return `<!doctype html><html lang="${lang === 'fr' ? 'fr' : 'ar'}" dir="${s.dir}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">
<title>${e(title)}</title><style>${fontCss}${CSS}</style></head>
<body class="${format === 'thermal' ? 'thermal' : 'a4'}">${body}</body></html>`;
}

function money(shop) {
  return (v) => {
    const t = formatMoney(v, { decimals: shop.decimals, symbol: '' });
    return `${ltr(t)}${shop.symbol ? ` ${e(shop.symbol)}` : ''}`;
  };
}

function headerHtml(shop, s, title, number, dateText) {
  const logo = shop.logoDataUri ? `<img src="${e(shop.logoDataUri)}" alt="">` : '';
  const contact = [shop.phone ? `${e(s.phone)}: ${ltr(shop.phone)}` : '', shop.address ? e(shop.address) : '']
    .filter(Boolean).join(' · ');
  return `<header class="top"><div class="shop">${logo}<div><div class="name">${e(shop.name)}</div>
<div class="muted">${contact}</div></div></div>
<div class="doc"><div class="title">${e(title)}</div>${number ? `<div>${ltr(number)}</div>` : ''}${dateText ? `<div class="muted">${ltr(dateText)}</div>` : ''}</div></header>`;
}

function partyBox(s, label, party, walkIn) {
  const name = party?.name ? e(party.name) : e(walkIn ?? '');
  const lines = [];
  if (party?.phone) lines.push(`${e(s.phone)}: ${ltr(party.phone)}`);
  if (party?.address) lines.push(e(party.address));
  return `<div class="box"><span class="k">${e(label)}:</span> <b>${name}</b>${lines.length ? `<div class="muted">${lines.join(' · ')}</div>` : ''}</div>`;
}

const methodLabel = (s, key) => (key === 'both' ? s.cashAndCredit : key === 'credit' ? s.credit : s.cash);

/** Sale or purchase bill. */
export function billHtml(doc, { shop, lang, format }) {
  const s = stringsFor(lang);
  const m = money(shop);
  const thermal = format === 'thermal';
  const isSale = doc.variant === 'sale';
  const title = isSale ? s.saleInvoice : s.purchaseInvoice;
  const priceHead = isSale ? s.unitPrice : s.unitCost;

  const items = thermal
    ? doc.lines.map((l) => `<div class="item"><div>${e(l.name)}</div>
<div class="l2"><span>${ltr(l.qty)} × ${m(l.unit)}</span><b>${m(l.total)}</b></div></div>`).join('')
    : `<table><thead><tr><th style="width:32px">#</th><th>${e(s.item)}</th><th class="num">${e(s.qty)}</th>
<th class="num">${e(priceHead)}</th><th class="num">${e(s.lineTotal)}</th></tr></thead><tbody>
${doc.lines.map((l, i) => `<tr><td>${ltr(i + 1)}</td><td>${e(l.name)}</td><td class="num">${ltr(l.qty)}</td>
<td class="num">${m(l.unit)}</td><td class="num">${m(l.total)}</td></tr>`).join('')}</tbody></table>`;

  const row = (label, value, cls = '') => `<div class="r ${cls}"><span>${e(label)}</span><span>${value}</span></div>`;
  const totals = `<div class="totals">
${row(s.subtotal, m(doc.subtotal))}
${doc.discount > 0 ? row(s.discount, `- ${m(doc.discount)}`) : ''}
${doc.extraCosts > 0 ? row(s.extraCosts, `+ ${m(doc.extraCosts)}`) : ''}
${row(s.total, m(doc.total), 'grand')}
${row(s.paid, m(doc.paid))}
${doc.remaining > 0 ? row(s.remaining, m(doc.remaining), 'due') : ''}
${row(s.method, e(methodLabel(s, doc.methodKey)))}
</div>`;

  const voided = doc.voided
    ? `<div class="box"><span class="badge">${e(s.voided)}</span>${doc.voided.reason ? ` ${e(s.voidReason)}: ${e(doc.voided.reason)}` : ''}</div>` : '';
  const ref = !isSale && doc.invoiceRef ? `<div class="muted">${e(s.invoiceRef)}: ${ltr(doc.invoiceRef)}</div>` : '';

  return `<div class="page">${doc.voided ? `<div class="wm">${e(s.voided)}</div>` : ''}
${headerHtml(shop, s, title, doc.number, doc.dateText)}
${voided}${partyBox(s, isSale ? s.client : s.supplier, doc.party, isSale ? s.walkIn : '')}${ref}
${items}${totals}
${doc.note ? `<div class="note"><b>${e(s.note)}:</b> ${e(doc.note)}</div>` : ''}
<div class="foot">${e(s.thanks)}</div></div>`;
}

/** Customer / supplier payment receipt. */
export function receiptHtml(doc, { shop, lang, format }) {
  const s = stringsFor(lang);
  const m = money(shop);
  const isCustomer = doc.variant === 'customer';
  const title = isCustomer ? s.customerReceipt : s.supplierReceipt;
  const alloc = doc.allocations.length
    ? `<h3>${e(s.settledInvoices)}</h3><table><thead><tr><th>${e(s.number)}</th><th class="num">${e(s.amount)}</th></tr></thead><tbody>
${doc.allocations.map((a) => `<tr><td>${ltr(a.number)}</td><td class="num">${m(a.amount)}</td></tr>`).join('')}</tbody></table>` : '';
  const row = (label, value, cls = '') => `<div class="r ${cls}"><span>${e(label)}</span><span>${value}</span></div>`;
  return `<div class="page">${headerHtml(shop, s, title, doc.number, doc.dateText)}
${partyBox(s, isCustomer ? s.client : s.supplier, doc.party, '')}
<div class="totals" ${format === 'thermal' ? '' : 'style="width:60%"'}>${row(s.amount, m(doc.amount), 'grand')}
${row(s.balanceNow, m(doc.balanceNow), doc.balanceNow > 0 ? 'due' : '')}</div>
${alloc}${doc.note ? `<div class="note"><b>${e(s.note)}:</b> ${e(doc.note)}</div>` : ''}
<div class="foot">${e(s.thanks)}</div></div>`;
}

/** Client or supplier account statement for a period (A4). */
export function statementHtml(doc, { shop, lang }) {
  const s = stringsFor(lang);
  const m = money(shop);
  const isClient = doc.variant === 'client';
  const title = isClient ? s.clientStatement : s.supplierStatement;
  const rows = doc.rows.map((r) => `<tr><td>${ltr(r.dateText)}</td><td>${e(s[r.labelKey] ?? r.labelKey)}${r.ref ? ` ${ltr(r.ref)}` : ''}</td>
<td class="num">${r.debit ? m(r.debit) : ''}</td><td class="num">${r.credit ? m(r.credit) : ''}</td><td class="num">${m(r.balance)}</td></tr>`).join('');
  return `<div class="page">${headerHtml(shop, s, title, '', '')}
${partyBox(s, isClient ? s.client : s.supplier, doc.party, '')}
<div class="box"><span class="k">${e(s.period)}:</span> ${e(s.from)} ${ltr(doc.fromText)} ${e(s.to)} ${ltr(doc.toText)}</div>
<div class="cards"><div class="card"><div class="muted">${e(s.openingBalance)}</div><div class="v">${m(doc.opening)}</div></div>
<div class="card"><div class="muted">${e(s.closingBalance)}</div><div class="v">${m(doc.closing)}</div></div>
<div class="card"><div class="muted">${e(isClient ? s.clientOwes : s.weOwe)} (${e(s.balanceNow)})</div><div class="v">${m(doc.balanceNow)}</div></div></div>
${doc.rows.length ? `<table><thead><tr><th>${e(s.date)}</th><th>${e(s.description)}</th><th class="num">${e(s.debit)}</th><th class="num">${e(s.creditCol)}</th><th class="num">${e(s.balance)}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted">${e(s.none)}</p>`}
<div class="foot">${e(s.generatedAt)} ${ltr(doc.generatedText)}</div></div>`;
}

/** Expense report for a period (A4). Archived expenses never reach this model. */
export function expenseReportHtml(doc, { shop, lang }) {
  const s = stringsFor(lang);
  const m = money(shop);
  const rows = doc.rows.map((r) => `<tr><td>${ltr(r.dateText)}</td><td>${ltr(r.number)}</td><td>${e(r.title)}</td><td>${e(r.categoryName)}</td><td class="num">${m(r.amount)}</td></tr>`).join('');
  return `<div class="page">${headerHtml(shop, s, s.expenseReport, '', '')}
<div class="box"><span class="k">${e(s.period)}:</span> ${e(s.from)} ${ltr(doc.fromText)} ${e(s.to)} ${ltr(doc.toText)}
 · <span class="k">${e(s.category)}:</span> ${e(doc.categoryName ?? s.allCategories)}</div>
<div class="cards"><div class="card"><div class="muted">${e(s.total)}</div><div class="v">${m(doc.total)}</div></div>
<div class="card"><div class="muted">${e(s.count)}</div><div class="v">${ltr(doc.count)}</div></div></div>
${doc.byCategory.length ? `<h3>${e(s.byCategory)}</h3><table><thead><tr><th>${e(s.category)}</th><th class="num">${e(s.count)}</th><th class="num">${e(s.amount)}</th></tr></thead><tbody>
${doc.byCategory.map((c) => `<tr><td>${e(c.name)}</td><td class="num">${ltr(c.count)}</td><td class="num">${m(c.total)}</td></tr>`).join('')}</tbody></table>` : ''}
<h3>${e(s.expenses)}</h3>
${doc.rows.length ? `<table><thead><tr><th>${e(s.date)}</th><th>${e(s.number)}</th><th>${e(s.title)}</th><th>${e(s.category)}</th><th class="num">${e(s.amount)}</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="4">${e(s.totals)}</td><td class="num">${m(doc.total)}</td></tr></tfoot></table>` : `<p class="muted">${e(s.none)}</p>`}
${doc.truncated ? `<p class="muted">${e(s.truncated)}</p>` : ''}
<div class="foot">${e(s.generatedAt)} ${ltr(doc.generatedText)}</div></div>`;
}

/** Sales report for a period (A4): per-day summary from daily_stats + the invoice list. */
export function salesReportHtml(doc, { shop, lang }) {
  const s = stringsFor(lang);
  const m = money(shop);
  const t = doc.totals;
  const days = doc.days.map((d) => `<tr><td>${ltr(d.dateText)}</td><td class="num">${ltr(d.salesCount)}</td><td class="num">${m(d.gross)}</td><td class="num">${m(d.voided)}</td>
<td class="num">${m(d.net)}</td><td class="num">${m(d.cash)}</td><td class="num">${m(d.credit)}</td><td class="num">${m(d.payments)}</td><td class="num">${m(d.profit)}</td></tr>`).join('');
  const sales = doc.sales.map((x) => `<tr><td>${ltr(x.dateText)}</td><td>${ltr(x.number)}</td><td>${e(x.clientName || s.walkIn)}</td><td class="num">${m(x.total)}</td><td class="num">${m(x.paid)}</td>
<td>${x.voided ? `<span class="badge">${e(s.voided)}</span>` : e(s.active)}</td></tr>`).join('');
  return `<div class="page">${headerHtml(shop, s, s.salesReport, '', '')}
<div class="box"><span class="k">${e(s.period)}:</span> ${e(s.from)} ${ltr(doc.fromText)} ${e(s.to)} ${ltr(doc.toText)}</div>
<div class="cards"><div class="card"><div class="muted">${e(s.netSales)}</div><div class="v">${m(t.net)}</div></div>
<div class="card"><div class="muted">${e(s.grossProfit)}</div><div class="v">${m(t.profit)}</div></div>
<div class="card"><div class="muted">${e(s.paymentsReceived)}</div><div class="v">${m(t.payments)}</div></div>
<div class="card"><div class="muted">${e(s.salesCount)}</div><div class="v">${ltr(t.salesCount)}</div></div></div>
${doc.days.length ? `<table><thead><tr><th>${e(s.day)}</th><th class="num">${e(s.salesCount)}</th><th class="num">${e(s.grossSales)}</th><th class="num">${e(s.voidedSales)}</th><th class="num">${e(s.netSales)}</th>
<th class="num">${e(s.cashSales)}</th><th class="num">${e(s.creditSales)}</th><th class="num">${e(s.paymentsReceived)}</th><th class="num">${e(s.grossProfit)}</th></tr></thead><tbody>${days}</tbody>
<tfoot><tr><td>${e(s.totals)}</td><td class="num">${ltr(t.salesCount)}</td><td class="num">${m(t.gross)}</td><td class="num">${m(t.voided)}</td><td class="num">${m(t.net)}</td>
<td class="num">${m(t.cash)}</td><td class="num">${m(t.credit)}</td><td class="num">${m(t.payments)}</td><td class="num">${m(t.profit)}</td></tr></tfoot></table>` : `<p class="muted">${e(s.none)}</p>`}
${doc.sales.length ? `<h3>${e(s.salesList)}</h3><table><thead><tr><th>${e(s.date)}</th><th>${e(s.number)}</th><th>${e(s.client)}</th><th class="num">${e(s.total)}</th><th class="num">${e(s.paid)}</th><th>${e(s.status)}</th></tr></thead><tbody>${sales}</tbody></table>` : ''}
${doc.truncated ? `<p class="muted">${e(s.truncated)}</p>` : ''}
<div class="foot">${e(s.generatedAt)} ${ltr(doc.generatedText)}</div></div>`;
}

export function profitReportHtml(doc, { shop, lang }) {
  const s = stringsFor(lang);
  const m = money(shop);
  const t = doc.totals;
  const line = (label, v, bold) => `<tr${bold ? ' class="b"' : ''}><td>${e(label)}</td><td class="num">${m(v)}</td></tr>`;
  const days = doc.days.map((d) => `<tr><td>${ltr(d.dateText)}</td><td class="num">${m(d.net)}</td><td class="num">${m(d.grossProfit)}</td><td class="num">${m(d.expenses)}</td><td class="num">${m(d.netProfit)}</td></tr>`).join('');
  return `<div class="page">${headerHtml(shop, s, s.profitReport, '', '')}
<div class="box"><span class="k">${e(s.period)}:</span> ${e(s.from)} ${ltr(doc.fromText)} ${e(s.to)} ${ltr(doc.toText)}</div>
<div class="cards"><div class="card"><div class="muted">${e(s.netSales)}</div><div class="v">${m(t.net)}</div></div>
<div class="card"><div class="muted">${e(s.grossProfit)}</div><div class="v">${m(t.grossProfit)}</div></div>
<div class="card"><div class="muted">${e(s.expenses)}</div><div class="v">${m(t.expenses)}</div></div>
<div class="card"><div class="muted">${e(s.netProfit)}</div><div class="v">${m(t.netProfit)}</div></div></div>
${doc.days.length ? `<h3>${e(s.profitStatement)}</h3><table><tbody>
${line(s.grossSales, t.gross)}${line(s.voidedSales, -t.voided)}${line(s.netSales, t.net, true)}${line(s.costOfSales, -t.cogs)}${line(s.grossProfit, t.grossProfit, true)}${line(s.expenses, -t.expenses)}${line(s.netProfit, t.netProfit, true)}
</tbody></table>
<table><tbody>${line(s.discountsGiven, t.discounts)}${line(s.cashReceived, t.cashIn)}${line(s.creditSales, t.credit)}${line(s.purchasesNet, t.purchases)}${line(s.supplierPaid, t.supplierPaid)}</tbody></table>
<h3>${e(s.day)}</h3><table><thead><tr><th>${e(s.day)}</th><th class="num">${e(s.netSales)}</th><th class="num">${e(s.grossProfit)}</th><th class="num">${e(s.expenses)}</th><th class="num">${e(s.netProfit)}</th></tr></thead><tbody>${days}</tbody>
<tfoot><tr><td>${e(s.totals)}</td><td class="num">${m(t.net)}</td><td class="num">${m(t.grossProfit)}</td><td class="num">${m(t.expenses)}</td><td class="num">${m(t.netProfit)}</td></tr></tfoot></table>
<p class="muted">${e(s.profitNote)}</p>` : `<p class="muted">${e(s.none)}</p>`}
<div class="foot">${e(s.generatedAt)} ${ltr(doc.generatedText)}</div></div>`;
}

export const BUILDERS = {
  bill: billHtml, receipt: receiptHtml, statement: statementHtml, expenseReport: expenseReportHtml, salesReport: salesReportHtml, profitReport: profitReportHtml,
};

export function titleOf(doc, lang) {
  const s = stringsFor(lang);
  return {
    bill: doc.variant === 'sale' ? s.saleInvoice : s.purchaseInvoice,
    receipt: doc.variant === 'customer' ? s.customerReceipt : s.supplierReceipt,
    statement: doc.variant === 'client' ? s.clientStatement : s.supplierStatement,
    expenseReport: s.expenseReport,
    salesReport: s.salesReport,
    profitReport: s.profitReport,
  }[doc.kind];
}

export function renderDocument(doc, { shop, lang = 'ar', format = 'a4', fontCss }) {
  const build = BUILDERS[doc.kind];
  if (!build) throw new Error(`unknown document kind ${doc.kind}`);
  const body = build(doc, { shop, lang, format });
  return documentShell({ lang, format, fontCss, body, title: titleOf(doc, lang) });
}
