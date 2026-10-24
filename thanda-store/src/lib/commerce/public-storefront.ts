import fs from 'node:fs';
import path from 'node:path';
import pool from '@/lib/db';
import selection from '../../../data/public-featured-products.json';
import { loadSkuSuccessions } from '@/lib/sku-successions.mjs';
import { selectPublicProducts } from './public-storefront.mjs';

export type PublicProduct = {
  id: number; supplier: string; sku: string; name: string; category: string; summary: string;
  imageUrl: string | null; requestQuoteUrl: string;
  availability: { local: 'in_stock' | 'out_of_stock' | 'unknown'; observedAt: string | null };
};

// Local reads only. No thumbnail generation, supplier requests or account pricing.
export async function publicFeaturedProducts(): Promise<PublicProduct[]> {
  if (!selection.length) return [];
  const [result, successions] = await Promise.all([
    pool.query(`SELECT id,supplier,sku,name,category,image_url,
      jsonb_build_object('hidden',details->'hidden','xeroStockStatus',details->'xeroStockStatus',
        'xeroStockSyncedAt',details->'xeroStockSyncedAt','localStockOnHand',details->'localStockOnHand',
        'cataloguePresent',details->'cataloguePresent') ||
      CASE WHEN details ? 'catalogueVisibility' THEN jsonb_build_object('catalogueVisibility',details->'catalogueVisibility') ELSE '{}'::jsonb END AS details
      FROM products WHERE supplier IN ('victron','lora')`),
    loadSkuSuccessions(pool),
  ]);
  return selectPublicProducts(result.rows, successions, selection, {
    hasThumbnail: (row: { supplier: string; sku: string }) => fs.existsSync(path.join(process.cwd(), 'public', 'product-images', row.supplier, `${row.sku}.webp`)),
  }) as PublicProduct[];
}
