import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';

const VAT_RATE = 0.15;
const MAX_B2B_DISCOUNT_PERCENT = 40;
const DEFAULT_B2B_DISCOUNT_PERCENT = 30;
const THUMBNAIL_RETRY_MS = 5 * 60 * 1000;
const thumbnailQueuedAt = new Map<number, number>();

export const runtime = 'nodejs';

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function recommendedRetailExVat(product: { supplier?: string; details?: Record<string, unknown> }) {
  const details = product.details || {};
  const explicitExVat = numberOrNull(details.recommendedRetailExVat);
  if (explicitExVat !== null) return explicitExVat;

  const originalPrice = numberOrNull(details.originalPrice);
  if (originalPrice === null) return null;

  if (details.recommendedRetailPriceVatMode === 'ex_vat') return originalPrice;
  if (details.recommendedRetailPriceVatMode === 'incl_vat') return roundMoney(originalPrice / (1 + VAT_RATE));

  return product.supplier === 'victron'
    ? originalPrice
    : roundMoney(originalPrice / (1 + VAT_RATE));
}

function configuredDiscountPercent(supplier: string, userDiscounts: Record<string, number>) {
  const requested = userDiscounts[supplier.toLowerCase()]
    ?? numberOrNull(process.env.DEFAULT_B2B_DISCOUNT_PERCENT)
    ?? DEFAULT_B2B_DISCOUNT_PERCENT;
  return Math.max(0, Math.min(requested, MAX_B2B_DISCOUNT_PERCENT));
}

function buyerPriceExVat(product: { supplier?: string; details?: Record<string, unknown> }, retailExVat: number | null, discountPercent: number) {
  if (retailExVat === null) return null;
  if (product.supplier === 'lora') return retailExVat;
  return roundMoney(retailExVat * (1 - discountPercent / 100));
}

function displayDetails(details: Record<string, unknown>, product: { price?: unknown }) {
  return {
    localStockOnHand: numberOrNull(details.localStockOnHand),
    supplierStockLabel: typeof details.supplierStockLabel === 'string' ? details.supplierStockLabel : null,
    supplierAvailability: typeof details.supplierAvailability === 'string' ? details.supplierAvailability : null,
    manualAvailability: typeof details.manualAvailability === 'string' ? details.manualAvailability : null,
    is120vAc: details.is120vAc === true,
    productNotes: Array.isArray(details.productNotes) ? details.productNotes.filter((note) => typeof note === 'string') : [],
    distributorPrice: numberOrNull(product.price),
    maxB2bDiscountPercent: MAX_B2B_DISCOUNT_PERCENT,
  };
}

function safePathPart(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function productThumbnailUrl(product: { id: unknown; supplier?: string; sku?: string }) {
  const supplier = safePathPart(product.supplier?.toLowerCase()) || 'unknown';
  const sku = safePathPart(product.sku) || String(product.id);
  const filePath = path.join(process.cwd(), 'public', 'product-images', supplier, `${sku}.webp`);
  return fs.existsSync(filePath) ? `/api/product-images/${supplier}/${sku}` : '';
}

function queueMissingThumbnails(products: Array<{ id: number; image_url?: string; supplier?: string; sku?: string }>) {
  const now = Date.now();
  const ids = products
    .filter((product) => product.image_url && !productThumbnailUrl(product))
    .filter((product) => now - (thumbnailQueuedAt.get(product.id) || 0) >= THUMBNAIL_RETRY_MS)
    .map((product) => product.id);

  if (ids.length === 0) return;

  ids.forEach((id) => thumbnailQueuedAt.set(id, now));
  const scriptPath = path.join(process.cwd(), 'scripts', 'generate-product-thumbnails.mjs');
  const args = [scriptPath, ...ids.flatMap((id) => ['--id', String(id)])];

  try {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: 'ignore',
    });
    child.once('error', (error) => {
      ids.forEach((id) => thumbnailQueuedAt.delete(id));
      console.error('Unable to queue product thumbnail generation:', error);
    });
    child.unref();
  } catch (error) {
    console.error('Unable to queue product thumbnail generation:', error);
  }
}

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

    const res = await pool.query(`
      SELECT id, name, supplier, category, price, sku, image_url, stock_on_hand, details
      FROM products
      WHERE COALESCE((details->>'hidden')::boolean, false) = false
    `);
    const products = res.rows.map((product) => {
      const details = product.details || {};
      const retailExVat = recommendedRetailExVat(product);
      const discountPercent = configuredDiscountPercent(product.supplier, user.discounts);
      const yourPriceExVat = buyerPriceExVat(product, retailExVat, discountPercent);

      return {
        ...product,
        thumbnail_url: productThumbnailUrl(product),
        recommended_retail_ex_vat: retailExVat,
        your_price_ex_vat: yourPriceExVat,
        b2b_discount_percent: product.supplier === 'lora' ? 0 : discountPercent,
        details: displayDetails(details, product),
      };
    }).sort((a, b) => {
      const categoryOrder = a.category.localeCompare(b.category, undefined, { sensitivity: 'base' });
      if (categoryOrder !== 0) return categoryOrder;
      return b.name.localeCompare(a.name, undefined, { sensitivity: 'base' });
    });

    queueMissingThumbnails(res.rows);

    return NextResponse.json(products);
  } catch (err) {
    console.error('API Error:', err);
    return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 });
  }
}
