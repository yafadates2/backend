// All prices are integer MILLIMES (TND has 3 decimals): 18 dt = 18000, 4.5 dt = 4500.

export const SETTINGS = {
  name: 'تمور يافا',
  phone: '',
  address: '',
  currencyCode: 'TND',
  currencySymbol: 'د.ت',
  minorUnitDecimals: 3,
  defaultLanguage: 'ar',
  logoKey: null,
  allowNegativeStock: false,
  invoicePrefix: 'TY',
};

export const CATEGORIES = [
  { id: 'cat_dates', name: 'التمور' },
  { id: 'cat_date_products', name: 'مشتقات التمر' },
  { id: 'cat_floral_waters', name: 'المياه العطرية' },
  { id: 'cat_traditional', name: 'المؤونة التقليدية' },
  { id: 'cat_oil', name: 'الزيت' },
  { id: 'cat_honey', name: 'العسل' },
];

export const PRODUCTS = [
  { id: 'prod_dahan_250', name: 'دهان 250غ', categoryId: 'cat_date_products', sellingPrice: 18000 },
  { id: 'prod_rub_250', name: 'رب 250غ', categoryId: 'cat_date_products', sellingPrice: 6500 },
  { id: 'prod_rub_500', name: 'رب 500غ', categoryId: 'cat_date_products', sellingPrice: 12000 },
  { id: 'prod_date_sugar_100', name: 'سكر التمر 100غ', categoryId: 'cat_date_products', sellingPrice: 2300 },

  { id: 'prod_deglet_1', name: 'دقلة النور صنف 1', categoryId: 'cat_dates', sellingPrice: 9000 },
  { id: 'prod_deglet_2', name: 'دقلة النور صنف 2', categoryId: 'cat_dates', sellingPrice: 7000 },
  { id: 'prod_deglet_3', name: 'دقلة النور صنف 3', categoryId: 'cat_dates', sellingPrice: 5000 },
  { id: 'prod_kaabar_1kg', name: 'الكعابر 1 كغ', categoryId: 'cat_dates', sellingPrice: 28000 },

  { id: 'prod_rose_water', name: 'ماء ورد', categoryId: 'cat_floral_waters', sellingPrice: 4500 },
  { id: 'prod_orange_blossom', name: 'ماء الزهر', categoryId: 'cat_floral_waters', sellingPrice: 4500 },
  { id: 'prod_atarsiya', name: 'عطرشية', categoryId: 'cat_floral_waters', sellingPrice: 4500 },
  { id: 'prod_flayo', name: 'فلايو', categoryId: 'cat_floral_waters', sellingPrice: 4500 },

  { id: 'prod_zrir_500', name: 'زرير 500غ', categoryId: 'cat_traditional', sellingPrice: 12000 },
  { id: 'prod_bsissa_500', name: 'بسيسة 500غ', categoryId: 'cat_traditional', sellingPrice: 7000 },
  { id: 'prod_dara_500', name: 'درع 500غ', categoryId: 'cat_traditional', sellingPrice: 6000 },

  { id: 'prod_oil_half', name: 'زيت نصف لتر', categoryId: 'cat_oil', sellingPrice: 6000 },
  { id: 'prod_oil_1l', name: 'زيت لتر', categoryId: 'cat_oil', sellingPrice: 12000 },

  { id: 'prod_honey_250', name: 'عسل 250غ', categoryId: 'cat_honey', sellingPrice: 25000 },
  { id: 'prod_honey_500', name: 'عسل 500غ', categoryId: 'cat_honey', sellingPrice: 50000 },
  { id: 'prod_honey_1kg', name: 'عسل كيلو', categoryId: 'cat_honey', sellingPrice: 100000 },
];

export const EXPENSE_CATEGORIES = [
  { id: 'exp_rent', name: 'الكراء' },
  { id: 'exp_electricity', name: 'الكهرباء' },
  { id: 'exp_transport', name: 'النقل' },
  { id: 'exp_maintenance', name: 'الصيانة' },
  { id: 'exp_salaries', name: 'الأجور' },
  { id: 'exp_other', name: 'مصاريف أخرى' },
];

/** `ts` is the server-timestamp sentinel (or any placeholder in tests). */
export function buildDocs(ts) {
  return [
    { path: 'shop_settings/main', data: { ...SETTINGS, createdAt: ts, updatedAt: ts } },
    ...CATEGORIES.map((c) => ({
      path: `categories/${c.id}`,
      data: { name: c.name, imageKey: null, isArchived: false, createdAt: ts, updatedAt: ts },
    })),
    ...PRODUCTS.map((p) => ({
      path: `products/${p.id}`,
      data: {
        name: p.name, imageKey: null, categoryId: p.categoryId,
        // Cost is unknown until stock is received (Phase 7) or entered in Phase 4.
        avgCost: 0, sellingPrice: p.sellingPrice, stockQty: 0, minStock: 0,
        description: '', isActive: true, createdAt: ts, updatedAt: ts,
      },
    })),
    ...EXPENSE_CATEGORIES.map((c) => ({
      path: `expense_categories/${c.id}`,
      data: { name: c.name, isArchived: false, createdAt: ts, updatedAt: ts },
    })),
  ];
}
