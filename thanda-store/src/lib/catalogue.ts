import fs from 'node:fs';
import path from 'node:path';
import pool from '@/lib/db';

const VAT_RATE = 0.15;
const MAX_B2B_DISCOUNT_PERCENT = 40;
const DEFAULT_B2B_DISCOUNT_PERCENT = 30;

export type CatalogueProduct = {
  id: number;
  name: string;
  supplier: string;
  category: string;
  price: string | number;
  sku: string;
  image_url: string;
  stock_on_hand: number;
  details: Record<string, unknown>;
  thumbnail_url: string;
  recommended_retail_ex_vat: number | null;
  your_price_ex_vat: number | null;
  b2b_discount_percent: number;
};

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function safePathPart(value: unknown) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function recommendedRetailExVat(product: { supplier?: string; details?: Record<string, unknown> }) {
  const details = product.details || {};
  const explicitExVat = numberOrNull(details.recommendedRetailExVat);
  if (explicitExVat !== null) return explicitExVat;
  const originalPrice = numberOrNull(details.originalPrice);
  if (originalPrice === null) return null;
  if (details.recommendedRetailPriceVatMode === 'ex_vat') return originalPrice;
  if (details.recommendedRetailPriceVatMode === 'incl_vat') return roundMoney(originalPrice / (1 + VAT_RATE));
  return product.supplier === 'victron' ? originalPrice : roundMoney(originalPrice / (1 + VAT_RATE));
}

function configuredDiscountPercent(supplier: string, userDiscounts: Record<string, number>) {
  const requested = userDiscounts[supplier.toLowerCase()] ?? Number(process.env.DEFAULT_B2B_DISCOUNT_PERCENT) ?? DEFAULT_B2B_DISCOUNT_PERCENT;
  return Math.max(0, Math.min(Number.isFinite(requested) ? requested : DEFAULT_B2B_DISCOUNT_PERCENT, MAX_B2B_DISCOUNT_PERCENT));
}

function displayDetails(details: Record<string, unknown>, price: unknown) {
  return {
    localStockOnHand: numberOrNull(details.localStockOnHand),
    supplierStockLabel: typeof details.supplierStockLabel === 'string' ? details.supplierStockLabel : null,
    supplierAvailability: typeof details.supplierAvailability === 'string' ? details.supplierAvailability : null,
    manualAvailability: typeof details.manualAvailability === 'string' ? details.manualAvailability : null,
    is120vAc: details.is120vAc === true,
    productNotes: Array.isArray(details.productNotes) ? details.productNotes.filter((note) => typeof note === 'string') : [],
    distributorPrice: numberOrNull(price),
    maxB2bDiscountPercent: MAX_B2B_DISCOUNT_PERCENT,
  };
}

function thumbnailUrl(product: { id: number; supplier: string; sku: string }) {
  const supplier = safePathPart(product.supplier.toLowerCase()) || 'unknown';
  const sku = safePathPart(product.sku) || String(product.id);
  return fs.existsSync(path.join(process.cwd(), 'public', 'product-images', supplier, `${sku}.webp`))
    ? `/api/product-images/${supplier}/${sku}` : '';
}

export function presentProduct(row: Omit<CatalogueProduct, 'thumbnail_url' | 'recommended_retail_ex_vat' | 'your_price_ex_vat' | 'b2b_discount_percent'>, discounts: Record<string, number>): CatalogueProduct {
  const retail = recommendedRetailExVat(row);
  const discount = row.supplier.toLowerCase() === 'lora' ? 0 : configuredDiscountPercent(row.supplier, discounts);
  return {
    ...row,
    details: displayDetails(row.details || {}, row.price),
    thumbnail_url: thumbnailUrl(row),
    recommended_retail_ex_vat: retail,
    your_price_ex_vat: retail === null ? null : row.supplier.toLowerCase() === 'lora' ? retail : roundMoney(retail * (1 - discount / 100)),
    b2b_discount_percent: discount,
  };
}

export async function currentCatalogue(discounts: Record<string, number>) {
  const result = await pool.query(`
    SELECT id, name, supplier, category, price, sku, image_url, stock_on_hand, details
    FROM products
    WHERE COALESCE((details->>'hidden')::boolean, false) = false
    ORDER BY category ASC, name DESC
  `);
  return result.rows.map((row) => presentProduct(row, discounts));
}
