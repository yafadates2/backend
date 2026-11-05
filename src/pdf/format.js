// Pure helpers for the PDF documents. Money is integer minor units, never a float.
const NBSP = '\u00A0';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Every dynamic value that reaches the HTML goes through this (names and notes are user text). */
export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const group = (digits) => {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += NBSP;
    out += digits[i];
  }
  return out;
};

/** Same output as lib/core/utils/money.dart: 1250500 -> "1 250.500 د.ت" (Western digits, NBSP grouping). */
export function formatMoney(minor, { decimals = 3, symbol = '' } = {}) {
  const n = Number.isSafeInteger(minor) ? minor : 0;
  const abs = Math.abs(n);
  const factor = 10 ** decimals;
  const whole = group(String(Math.floor(abs / factor)));
  const body = decimals === 0 ? whole : `${whole}.${String(abs % factor).padStart(decimals, '0')}`;
  const signed = n < 0 ? `-${body}` : body;
  return symbol ? `${signed} ${symbol}` : signed;
}

export function isValidBusinessDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "2026-11-03" -> "03/11/2026"; anything else is returned as is (escaped by the caller). */
export const formatBusinessDate = (s) =>
  isValidBusinessDate(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : String(s ?? '');

export function toDate(v) {
  if (v instanceof Date) return v;
  if (v && typeof v.toDate === 'function') return v.toDate(); // Firestore Timestamp
  return null; // missing, or a test stand-in
}

/** "03/11/2026 14:05" in the shop's time zone (PDF_TIMEZONE, default Africa/Tunis). */
export function formatDateTime(v, timeZone = 'Africa/Tunis') {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export const MAX_PERIOD_DAYS = 366;

export function daysInclusive(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function eachDate(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** File-name safe ASCII fragment (numbers like TY-000123 already are). */
export const safeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'document';
