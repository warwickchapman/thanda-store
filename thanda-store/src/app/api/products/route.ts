import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';

const VAT_RATE = 0.15;
const MAX_B2B_DISCOUNT_PERCENT = 40;
const DEFAULT_B2B_DISCOUNT_PERCENT = 30;

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

    return NextResponse.json(products);
  } catch (err) {
    console.error('API Error:', err);
    return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 });
  }
}
