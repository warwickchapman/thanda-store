import fs from 'node:fs';
import path from 'node:path';
import pool from '@/lib/db';
import summaries from '../../../data/public-product-summaries.json';
import { loadSkuSuccessions } from '@/lib/sku-successions.mjs';
import { favouritesWindowStart } from '@/lib/favourite-products.mjs';
import { selectPublicProducts } from './public-storefront.mjs';

export type PublicProduct = {
  id: number; supplier: string; sku: string; name: string; category: string; summary: string;
  imageUrl: string | null; requestQuoteUrl: string;
  availability: { local: 'in_stock' | 'out_of_stock' | 'unknown'; observedAt: string | null };
};

// Local reads only. No thumbnail generation, supplier requests or account pricing.
export async function publicFeaturedProducts(): Promise<PublicProduct[]> {
  const now = Date.now();
  const [result, successions, history] = await Promise.all([
    pool.query(`SELECT id,supplier,sku,name,category,image_url,stock_on_hand,
      jsonb_build_object('hidden',details->'hidden','xeroStockStatus',details->'xeroStockStatus',
        'xeroStockSyncedAt',details->'xeroStockSyncedAt','localStockOnHand',details->'localStockOnHand',
        'cataloguePresent',details->'cataloguePresent','supplierObservedAt',details->'supplierObservedAt',
        'supplierStockStatus',details->'supplierStockStatus','supplierStockManaged',details->'supplierStockManaged') ||
      CASE WHEN details ? 'catalogueVisibility' THEN jsonb_build_object('catalogueVisibility',details->'catalogueVisibility') ELSE '{}'::jsonb END AS details
      FROM products ORDER BY category ASC,name DESC`),
    loadSkuSuccessions(pool),
    pool.query(`SELECT invoice_id,sku,invoice_date,quantity FROM xero_sales_invoice_lines
      WHERE invoice_date >= $1::date`, [favouritesWindowStart(now)]),
  ]);
  return selectPublicProducts(result.rows, successions, history.rows, summaries, {
    now,
    hasThumbnail: (row: { supplier: string; sku: string }) => fs.existsSync(path.join(process.cwd(), 'public', 'product-images', row.supplier, `${row.sku}.webp`)),
  }) as PublicProduct[];
}
