import { NextResponse } from 'next/server';
import pool from '@/lib/db';

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

function configuredDiscountPercent() {
  const requested = numberOrNull(process.env.DEFAULT_B2B_DISCOUNT_PERCENT) ?? DEFAULT_B2B_DISCOUNT_PERCENT;
  return Math.max(0, Math.min(requested, MAX_B2B_DISCOUNT_PERCENT));
}

export async function GET() {
  try {
    const res = await pool.query("SELECT * FROM products WHERE COALESCE((details->>'hidden')::boolean, false) = false");
    const discountPercent = configuredDiscountPercent();
    const products = res.rows.map((product) => {
      const details = product.details || {};
      const retailExVat = recommendedRetailExVat(product);
      const yourPriceExVat = retailExVat === null
        ? null
        : roundMoney(retailExVat * (1 - discountPercent / 100));

      return {
        ...product,
        recommended_retail_ex_vat: retailExVat,
        your_price_ex_vat: yourPriceExVat,
        b2b_discount_percent: discountPercent,
        details: {
          ...details,
          distributorPrice: numberOrNull(product.price),
          maxB2bDiscountPercent: MAX_B2B_DISCOUNT_PERCENT,
        },
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
