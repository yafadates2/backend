import { describe, it, expect } from 'vitest';
import { buildDocs, CATEGORIES, PRODUCTS, EXPENSE_CATEGORIES, SETTINGS } from '../scripts/seed-data.js';

describe('seed data', () => {
  const docs = buildDocs('TS');

  it('has unique ids and unique product names', () => {
    const paths = docs.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(PRODUCTS.map((p) => p.name)).size).toBe(PRODUCTS.length);
  });
  it('every product points at an existing category', () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const p of PRODUCTS) expect(ids.has(p.categoryId), p.id).toBe(true);
  });
  it('prices are positive integers in millimes', () => {
    for (const p of PRODUCTS) {
      expect(Number.isInteger(p.sellingPrice), p.id).toBe(true);
      expect(p.sellingPrice).toBeGreaterThan(0);
    }
  });
  it('matches the shop owner\'s price list', () => {
    const price = (name) => PRODUCTS.find((p) => p.name === name)?.sellingPrice;
    expect(PRODUCTS).toHaveLength(20);
    expect(price('دهان 250غ')).toBe(18000);
    expect(price('رب 250غ')).toBe(6500);
    expect(price('رب 500غ')).toBe(12000);
    expect(price('دقلة النور صنف 1')).toBe(9000);
    expect(price('دقلة النور صنف 2')).toBe(7000);
    expect(price('دقلة النور صنف 3')).toBe(5000);
    for (const n of ['ماء ورد', 'ماء الزهر', 'عطرشية', 'فلايو']) expect(price(n)).toBe(4500);
    expect(price('زرير 500غ')).toBe(12000);
    expect(price('بسيسة 500غ')).toBe(7000);
    expect(price('درع 500غ')).toBe(6000);
    expect(price('زيت نصف لتر')).toBe(6000);
    expect(price('زيت لتر')).toBe(12000);
    expect(price('عسل 250غ')).toBe(25000);
    expect(price('عسل 500غ')).toBe(50000);
    expect(price('عسل كيلو')).toBe(100000);
    expect(price('سكر التمر 100غ')).toBe(2300);
    expect(price('الكعابر 1 كغ')).toBe(28000);
  });
  it('settings use 3 decimals, Arabic and the shop name', () => {
    expect(SETTINGS.minorUnitDecimals).toBe(3);
    expect(SETTINGS.defaultLanguage).toBe('ar');
    expect(SETTINGS.name).toBe('تمور يافا');
  });
  it('creates settings, categories, products and expense categories', () => {
    expect(docs.filter((d) => d.path.startsWith('categories/'))).toHaveLength(CATEGORIES.length);
    expect(docs.filter((d) => d.path.startsWith('expense_categories/'))).toHaveLength(EXPENSE_CATEGORIES.length);
    expect(docs[0].path).toBe('shop_settings/main');
  });
  it('new products start with no stock and unknown (0) cost', () => {
    for (const d of docs.filter((x) => x.path.startsWith('products/'))) {
      expect(d.data.stockQty).toBe(0);
      expect(d.data.avgCost).toBe(0);
      expect(d.data.isActive).toBe(true);
    }
  });
});
