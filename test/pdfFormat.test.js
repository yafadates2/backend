import { describe, it, expect } from 'vitest';
import {
  escapeHtml, formatMoney, formatBusinessDate, isValidBusinessDate, formatDateTime, daysInclusive, eachDate, safeName,
} from '../src/pdf/format.js';

describe('formatMoney (same output as Money.format in Flutter)', () => {
  it('formats millimes with NBSP grouping and the symbol', () => {
    expect(formatMoney(18000, { decimals: 3, symbol: 'د.ت' })).toBe('18.000 د.ت');
    expect(formatMoney(1250500, { decimals: 3, symbol: 'د.ت' })).toBe('1\u00A0250.500 د.ت');
    expect(formatMoney(5, { decimals: 3 })).toBe('0.005');
    expect(formatMoney(-1500, { decimals: 3 })).toBe('-1.500');
    expect(formatMoney(1234, { decimals: 0 })).toBe('1\u00A0234');
  });
  it('never prints NaN or floats for bad input', () => {
    expect(formatMoney(undefined, { decimals: 3 })).toBe('0.000');
    expect(formatMoney(1.5, { decimals: 3 })).toBe('0.000');
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters and tolerates null', () => {
    expect(escapeHtml('<img src=x onerror="a()">&\'')).toBe('&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isValidBusinessDate('2026-11-03')).toBe(true);
    expect(isValidBusinessDate('2026-02-30')).toBe(false);
    expect(isValidBusinessDate('2026-1-3')).toBe(false);
    expect(isValidBusinessDate(undefined)).toBe(false);
  });
  it('formats and iterates', () => {
    expect(formatBusinessDate('2026-11-03')).toBe('03/11/2026');
    expect(daysInclusive('2026-11-01', '2026-11-03')).toBe(3);
    expect(eachDate('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
  it('prints date-times in the shop time zone and survives non-dates', () => {
    expect(formatDateTime(new Date('2026-11-03T12:05:00Z'), 'Africa/Tunis')).toBe('03/11/2026 13:05');
    expect(formatDateTime(12345)).toBe('');
    expect(formatDateTime({ toDate: () => new Date('2026-11-03T23:30:00Z') }, 'Africa/Tunis')).toBe('04/11/2026 00:30');
  });
  it('safeName keeps file names ASCII', () => {
    expect(safeName('TY-000123')).toBe('TY-000123');
    expect(safeName('فاتورة/../x')).toBe('_.._x');
  });
});
