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

type CatalogueRow = Omit<CatalogueProduct, 'thumbnail_url' | 'recommended_retail_ex_vat' | 'your_price_ex_vat' | 'b2b_discount_percent'>;

type ImageFallback = {
  predecessorSku: string;
  imageUrl: string;
  thumbnailUrl: string;
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

function displayDetails(details: Record<string, unknown>, price: unknown, imageFallbackFromSku: string | null = null) {
  return {
    localStockOnHand: numberOrNull(details.localStockOnHand),
    supplierStockLabel: typeof details.supplierStockLabel === 'string' ? details.supplierStockLabel : null,
    supplierAvailability: typeof details.supplierAvailability === 'string' ? details.supplierAvailability : null,
    manualAvailability: typeof details.manualAvailability === 'string' ? details.manualAvailability : null,
    is120vAc: details.is120vAc === true,
    productNotes: Array.isArray(details.productNotes) ? details.productNotes.filter((note) => typeof note === 'string') : [],
    xeroStockStatus: typeof details.xeroStockStatus === 'string' ? details.xeroStockStatus : null,
    distributorPrice: numberOrNull(price),
    imageFallbackFromSku,
    maxB2bDiscountPercent: MAX_B2B_DISCOUNT_PERCENT,
  };
}

function thumbnailUrl(product: { id: number; supplier: string; sku: string }) {
  const supplier = safePathPart(product.supplier.toLowerCase()) || 'unknown';
  const sku = safePathPart(product.sku) || String(product.id);
  return fs.existsSync(path.join(process.cwd(), 'public', 'product-images', supplier, `${sku}.webp`))
    ? `/api/product-images/${supplier}/${sku}` : '';
}

export function presentProduct(row: CatalogueRow, discounts: Record<string, number>, imageFallback: ImageFallback | null = null): CatalogueProduct {
  const retail = recommendedRetailExVat(row);
  const discount = row.supplier.toLowerCase() === 'lora' ? 0 : configuredDiscountPercent(row.supplier, discounts);
  const ownThumbnailUrl = thumbnailUrl(row);
  const ownImageUrl = row.image_url.trim();
  const hasOwnImage = Boolean(ownThumbnailUrl || ownImageUrl);
  const useFallback = !hasOwnImage && imageFallback !== null;
  return {
    ...row,
    image_url: useFallback ? imageFallback.imageUrl : ownImageUrl,
    details: displayDetails(row.details || {}, row.price, useFallback ? imageFallback.predecessorSku : null),
    thumbnail_url: ownThumbnailUrl || (useFallback ? imageFallback.thumbnailUrl : ''),
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
  const fallbackResult = await pool.query<{
    successor_sku: string;
    predecessor_sku: string;
    id: number;
    supplier: string;
    sku: string;
    image_url: string;
  }>(`
    SELECT s.successor_sku, s.predecessor_sku, p.id, p.supplier, p.sku, p.image_url
    FROM victron_sku_successions s
    JOIN products p ON p.supplier = 'victron' AND p.sku = s.predecessor_sku
  `).catch((error: { code?: string }) => {
    // The supplier sync creates this table; a freshly rebuilt database can
    // serve the catalogue normally before the first Victron sync completes.
    if (error.code === '42P01') return { rows: [] as Array<{
      successor_sku: string; predecessor_sku: string; id: number; supplier: string; sku: string; image_url: string;
    }> };
    throw error;
  });
  const fallbacksBySuccessorSku = new Map<string, ImageFallback>();
  for (const source of fallbackResult.rows) {
    const imageUrl = String(source.image_url || '').trim();
    const sourceThumbnailUrl = thumbnailUrl(source);
    if (!imageUrl && !sourceThumbnailUrl) continue;
    fallbacksBySuccessorSku.set(source.successor_sku.toUpperCase(), {
      predecessorSku: source.predecessor_sku,
      imageUrl,
      thumbnailUrl: sourceThumbnailUrl,
    });
  }
  return result.rows.map((row) => presentProduct(row, discounts, fallbacksBySuccessorSku.get(row.sku.toUpperCase()) || null));
}
