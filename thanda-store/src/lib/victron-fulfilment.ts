import pool from '@/lib/db';
import { localStockObservation, supplierStockObservation } from '@/lib/data-freshness.mjs';

type FulfilmentRow = {
  id: number;
  sku: string;
  supplier: string;
  stock_on_hand: string | number;
  details: Record<string, unknown>;
  is_predecessor: boolean;
  depth: number;
};

export type FulfilmentProduct = {
  id: number;
  sku: string;
  supplier: string;
  hasStock: boolean;
  substituted: boolean;
};

function hasStock(row: Pick<FulfilmentRow, 'supplier' | 'stock_on_hand' | 'details'>) {
  return Number(supplierStockObservation(row).quantity) > 0 || Number(localStockObservation(row).quantity) > 0;
}

export function isSupplierProductAvailable(product: Pick<FulfilmentProduct, 'supplier' | 'hasStock'>) {
  return !['renogy', 'victron'].includes(product.supplier.toLowerCase()) || product.hasStock;
}

/**
 * Resolve a Victron replacement family for fulfilment. Stocked predecessor
 * SKUs win; when none are stocked, the newest SKU is used for procurement.
 */
export async function resolveFulfilmentProduct(productId: number): Promise<FulfilmentProduct | null> {
  const result = await pool.query<FulfilmentRow>(`
    WITH RECURSIVE sku_family AS (
      SELECT
        p.id,
        p.sku,
        p.supplier,
        p.stock_on_hand,
        p.details,
        ARRAY[UPPER(p.sku)]::text[] AS path,
        0 AS depth
      FROM products p
      WHERE p.id = $1
        AND COALESCE((p.details->>'hidden')::boolean, false) = false

      UNION ALL

      SELECT
        next_product.id,
        next_product.sku,
        next_product.supplier,
        next_product.stock_on_hand,
        next_product.details,
        family.path || UPPER(next_product.sku),
        family.depth + 1
      FROM sku_family family
      JOIN victron_sku_successions succession
        ON UPPER(succession.predecessor_sku) = UPPER(family.sku)
          OR UPPER(succession.successor_sku) = UPPER(family.sku)
      JOIN products next_product
        ON next_product.supplier = 'victron'
          AND UPPER(next_product.sku) = CASE
            WHEN UPPER(succession.predecessor_sku) = UPPER(family.sku)
              THEN UPPER(succession.successor_sku)
            ELSE UPPER(succession.predecessor_sku)
          END
          AND COALESCE((next_product.details->>'hidden')::boolean, false) = false
      WHERE NOT UPPER(next_product.sku) = ANY(family.path)
    )
    SELECT
      family.id,
      family.sku,
      family.supplier,
      family.stock_on_hand,
      family.details,
      EXISTS (
        SELECT 1
        FROM victron_sku_successions succession
        WHERE UPPER(succession.predecessor_sku) = UPPER(family.sku)
      ) AS is_predecessor,
      family.depth
    FROM sku_family family
  `, [productId]).catch(async (error: { code?: string }) => {
    // A newly provisioned database may not have the succession table until
    // its first Victron import. Preserve normal ordering in that state.
    if (error.code !== '42P01') throw error;
    return pool.query<FulfilmentRow>(`
      SELECT id, sku, supplier, stock_on_hand,
        details,
        false AS is_predecessor,
        0 AS depth
      FROM products
      WHERE id = $1 AND COALESCE((details->>'hidden')::boolean, false) = false
    `, [productId]);
  });

  if (!result.rowCount) return null;
  const rows = result.rows;
  const requested = rows.find((row) => row.id === productId) || rows[0];
  if (requested.supplier.toLowerCase() !== 'victron') {
    return { id: Number(requested.id), sku: requested.sku, supplier: requested.supplier, hasStock: hasStock(requested), substituted: false };
  }

  // A predecessor is an older article code. Prefer the closest stocked older
  // code, then fall through to the terminal (newest) code for Victron ordering.
  const selected = rows
    .filter((row) => row.is_predecessor && hasStock(row))
    .sort((left, right) => left.depth - right.depth || left.sku.localeCompare(right.sku))[0]
    || rows
      .filter((row) => !row.is_predecessor)
      .sort((left, right) => left.depth - right.depth || left.sku.localeCompare(right.sku))[0]
    || requested;

  return {
    id: Number(selected.id),
    sku: selected.sku,
    supplier: selected.supplier,
    hasStock: hasStock(selected),
    substituted: selected.id !== productId,
  };
}
