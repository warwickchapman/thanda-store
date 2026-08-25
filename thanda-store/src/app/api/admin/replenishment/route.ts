import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';

const SALES_WINDOWS = { recent: 30, baseline: 90 };
const LEAD_TIME_DAYS = 5;
const SAFETY_STOCK_DAYS = 2;
const TARGET_COVER_DAYS = 14;

type Succession = { predecessor_sku: string; successor_sku: string };
type ProductRow = { sku: string; name: string; local_stock: string | number | null; supplier_stock: string | number };
type SaleRow = { sku: string; sales_30: string | number; sales_90: string | number; last_sold_at: string | null };
type InboundRow = { sku: string; quantity: string | number };

function familyResolver(successions: Succession[]) {
  const parent = new Map<string, string>();
  const find = (sku: string): string => {
    const current = parent.get(sku) || sku;
    if (current === sku) return sku;
    const root = find(current);
    parent.set(sku, root);
    return root;
  };
  for (const { predecessor_sku, successor_sku } of successions) {
    const predecessor = predecessor_sku.toUpperCase();
    const successor = successor_sku.toUpperCase();
    const predecessorRoot = find(predecessor);
    const successorRoot = find(successor);
    if (predecessorRoot !== successorRoot) parent.set(successorRoot, predecessorRoot);
  }
  return find;
}

function wholeUnits(value: number) { return Math.max(0, Math.ceil(value - 1e-9)); }

export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  try {
    const [products, sales, inbound, successions] = await Promise.all([
      pool.query<ProductRow>(`
        SELECT sku, name, COALESCE(NULLIF(details->>'localStockOnHand', '')::numeric, 0) AS local_stock, stock_on_hand AS supplier_stock
        FROM products WHERE supplier = 'victron' AND COALESCE((details->>'hidden')::boolean, false) = false
      `),
      pool.query<SaleRow>(`
        SELECT UPPER(sku) AS sku,
          COALESCE(SUM(quantity) FILTER (WHERE invoice_date >= CURRENT_DATE - INTERVAL '${SALES_WINDOWS.recent} days'), 0) AS sales_30,
          COALESCE(SUM(quantity), 0) AS sales_90,
          MAX(invoice_date)::text AS last_sold_at
        FROM xero_sales_invoice_lines
        WHERE invoice_date >= CURRENT_DATE - INTERVAL '${SALES_WINDOWS.baseline} days'
        GROUP BY UPPER(sku)
      `),
      pool.query<InboundRow>(`
        SELECT UPPER(line.sku) AS sku, SUM(line.ordered_quantity - line.received_quantity) AS quantity
        FROM supplier_inbound_order_lines line
        JOIN supplier_inbound_orders inbound ON inbound.id = line.inbound_order_id
        WHERE inbound.supplier = 'victron' AND inbound.status = 'open' AND line.is_stock_item = true
        GROUP BY UPPER(line.sku)
      `),
      pool.query<Succession>('SELECT predecessor_sku, successor_sku FROM victron_sku_successions').catch((error: { code?: string }) => {
        if (error.code === '42P01') return { rows: [] as Succession[] };
        throw error;
      }),
    ]);
    const resolveFamily = familyResolver(successions.rows);
    const predecessorSkus = new Set(successions.rows.map((row) => row.predecessor_sku.toUpperCase()));
    const groups = new Map<string, { products: ProductRow[]; sales30: number; sales90: number; inbound: number; lastSoldAt: string | null }>();
    const groupFor = (sku: string) => {
      const family = resolveFamily(sku.toUpperCase());
      const group = groups.get(family) || { products: [], sales30: 0, sales90: 0, inbound: 0, lastSoldAt: null };
      groups.set(family, group);
      return group;
    };
    for (const product of products.rows) groupFor(product.sku).products.push(product);
    for (const row of sales.rows) {
      const group = groupFor(row.sku);
      group.sales30 += Number(row.sales_30) || 0;
      group.sales90 += Number(row.sales_90) || 0;
      if (!group.lastSoldAt || (row.last_sold_at && row.last_sold_at > group.lastSoldAt)) group.lastSoldAt = row.last_sold_at;
    }
    for (const row of inbound.rows) groupFor(row.sku).inbound += Number(row.quantity) || 0;

    const items = [...groups.entries()].flatMap(([family, group]) => {
      if (!group.products.length || group.sales90 <= 0) return [];
      const currentProduct = [...group.products]
        .sort((left, right) => Number(predecessorSkus.has(left.sku.toUpperCase())) - Number(predecessorSkus.has(right.sku.toUpperCase())) || left.sku.localeCompare(right.sku))[0];
      const localStock = group.products.reduce((total, product) => total + (Number(product.local_stock) || 0), 0);
      const supplierStock = group.products.reduce((total, product) => total + (Number(product.supplier_stock) || 0), 0);
      const dailyDemand = Math.max(group.sales30 / SALES_WINDOWS.recent, group.sales90 / SALES_WINDOWS.baseline);
      const reorderPoint = wholeUnits(dailyDemand * (LEAD_TIME_DAYS + SAFETY_STOCK_DAYS));
      const targetStock = wholeUnits(dailyDemand * TARGET_COVER_DAYS);
      const availablePosition = localStock + group.inbound;
      const suggestedOrder = wholeUnits(targetStock - availablePosition);
      return [{
        family, sku: currentProduct.sku, name: currentProduct.name,
        sales30: group.sales30, sales90: group.sales90, dailyDemand,
        localStock, inbound: group.inbound, supplierStock,
        daysCover: dailyDemand ? availablePosition / dailyDemand : null,
        reorderPoint, targetStock, suggestedOrder,
        status: suggestedOrder > 0 ? (availablePosition <= reorderPoint ? 'order_now' : 'top_up') : 'covered',
        lastSoldAt: group.lastSoldAt,
      }];
    }).sort((left, right) => right.suggestedOrder - left.suggestedOrder || right.dailyDemand - left.dailyDemand || left.sku.localeCompare(right.sku));
    return NextResponse.json({
      items,
      policy: { salesWindows: SALES_WINDOWS, leadTimeDays: LEAD_TIME_DAYS, safetyStockDays: SAFETY_STOCK_DAYS, targetCoverDays: TARGET_COVER_DAYS },
    });
  } catch (error) {
    console.error('Victron replenishment report error:', error);
    return NextResponse.json({ error: 'Unable to load the replenishment report.' }, { status: 500 });
  }
}
