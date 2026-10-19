import pool from '@/lib/db';
import { chooseFulfilmentProduct, familyMemberSkus, loadSkuSuccessions, normalizeSku, productHasStock } from '@/lib/sku-successions.mjs';

type FulfilmentRow = {
  id: number;
  sku: string;
  supplier: string;
  stock_on_hand: string | number;
  details: Record<string, unknown>;
};

export type FulfilmentProduct = {
  id: number;
  sku: string;
  supplier: string;
  hasStock: boolean;
  substituted: boolean;
};

export function isSupplierProductAvailable(product: Pick<FulfilmentProduct, 'supplier' | 'hasStock'>) {
  return !['renogy', 'victron'].includes(product.supplier.toLowerCase()) || product.hasStock;
}

/** Resolve only explicit, supplier-scoped relationships using stored data. */
export async function resolveFulfilmentProduct(productId: number): Promise<FulfilmentProduct | null> {
  const result = await pool.query<FulfilmentRow>(`
    SELECT id, sku, supplier, stock_on_hand, details
    FROM products
    WHERE id = $1 AND COALESCE((details->>'hidden')::boolean, false) = false
  `, [productId]);
  const requested = result.rows[0];
  if (!requested) return null;
  let selected = requested;
  if (['victron', 'renogy'].includes(requested.supplier.toLowerCase())) {
    const successions = await loadSkuSuccessions(pool);
    const members = familyMemberSkus(successions, requested.supplier, requested.sku)
      .map((sku) => normalizeSku(requested.supplier, sku));
    const family = await pool.query<FulfilmentRow>(`
      SELECT id, sku, supplier, stock_on_hand, details
      FROM products
      WHERE LOWER(supplier) = LOWER($1)
        AND CASE WHEN LOWER(supplier) = 'victron' THEN REGEXP_REPLACE(UPPER(TRIM(sku)), 'R$', '') ELSE UPPER(TRIM(sku)) END = ANY($2::text[])
        AND COALESCE((details->>'hidden')::boolean, false) = false
    `, [requested.supplier, members]);
    selected = chooseFulfilmentProduct(requested, family.rows, successions) || requested;
  }
  return {
    id: Number(selected.id), sku: selected.sku, supplier: selected.supplier,
    hasStock: productHasStock(selected), substituted: Number(selected.id) !== Number(productId),
  };
}
