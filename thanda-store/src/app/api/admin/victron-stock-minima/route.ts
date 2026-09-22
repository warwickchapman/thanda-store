import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { victronStockSku } from '@/lib/victron-sku';
import {
  familyMemberSkus,
  predecessorSkusForFamily,
  victronSkuFamilyResolver,
} from '@/lib/victron-sku-family.mjs';

type Succession = { predecessor_sku: string; successor_sku: string };
type ReviewProduct = { sku: string; name: string; hidden: boolean };
type SaleRow = { sku: string; sales_30: string | number; sales_90: string | number };
type MinimumRow = { sku: string; minimum_stock: string | number };

const SALES_WINDOWS = { recent: 30, baseline: 90 };
const TARGET_COVER_DAYS = 14;

function wholeUnits(value: number) {
  return Math.max(0, Math.round(value));
}

async function requireAdmin() {
  const user = await currentUser();
  return user?.role === 'admin' ? user : null;
}

async function saveFamilyMinimums(items: { sku: string; minimumStock: number }[]) {
  const successions = await pool.query<Succession>('SELECT predecessor_sku, successor_sku FROM victron_sku_successions').catch((error: { code?: string }) => {
    if (error.code === '42P01') return { rows: [] as Succession[] };
    throw error;
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      for (const sku of familyMemberSkus(successions.rows, item.sku)) await client.query(`
        INSERT INTO victron_stock_minima (sku, minimum_stock, source, updated_at)
        VALUES ($1, $2, 'admin', NOW())
        ON CONFLICT (sku) DO UPDATE SET minimum_stock = EXCLUDED.minimum_stock, source = 'admin', updated_at = NOW()
      `, [sku, item.minimumStock]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const [items, products, sales, minimums, successions] = await Promise.all([
    pool.query(`
      SELECT p.sku, p.name, COALESCE(m.minimum_stock, 0) AS minimum_stock, m.source
      FROM products p
      LEFT JOIN victron_stock_minima m ON UPPER(m.sku) = UPPER(p.sku)
      WHERE p.supplier = 'victron' AND COALESCE((p.details->>'hidden')::boolean, false) = false
      ORDER BY p.name, p.sku
    `),
    pool.query<ReviewProduct>(`
      SELECT sku, name, COALESCE((details->>'hidden')::boolean, false) AS hidden
      FROM products WHERE supplier = 'victron'
    `),
    pool.query<SaleRow>(`
      SELECT UPPER(sku) AS sku,
        COALESCE(SUM(quantity) FILTER (WHERE invoice_date >= CURRENT_DATE - INTERVAL '${SALES_WINDOWS.recent} days'), 0) AS sales_30,
        COALESCE(SUM(quantity), 0) AS sales_90
      FROM xero_sales_invoice_lines
      WHERE invoice_date >= CURRENT_DATE - INTERVAL '${SALES_WINDOWS.baseline} days'
      GROUP BY UPPER(sku)
    `),
    pool.query<MinimumRow>('SELECT UPPER(sku) AS sku, minimum_stock FROM victron_stock_minima'),
    pool.query<Succession>('SELECT predecessor_sku, successor_sku FROM victron_sku_successions').catch((error: { code?: string }) => {
      if (error.code === '42P01') return { rows: [] as Succession[] };
      throw error;
    }),
  ]);
  const resolveFamily = victronSkuFamilyResolver(successions.rows);
  const predecessorSkus = new Set(successions.rows.map((row) => victronStockSku(row.predecessor_sku)));
  const groups = new Map<string, {
    products: ReviewProduct[];
    minimumStock: number;
    sales30: number;
    sales90: number;
  }>();
  const groupFor = (sku: string) => {
    const family = resolveFamily(victronStockSku(sku));
    const group = groups.get(family) || { products: [], minimumStock: 0, sales30: 0, sales90: 0 };
    groups.set(family, group);
    return { family, group };
  };
  for (const product of products.rows) groupFor(product.sku).group.products.push(product);
  for (const minimum of minimums.rows) {
    const group = groupFor(minimum.sku).group;
    group.minimumStock = Math.max(group.minimumStock, Number(minimum.minimum_stock) || 0);
  }
  for (const sale of sales.rows) {
    const group = groupFor(sale.sku).group;
    group.sales30 += Number(sale.sales_30) || 0;
    group.sales90 += Number(sale.sales_90) || 0;
  }
  const review = [...groups.entries()]
    .filter(([, group]) => group.minimumStock > 0)
    .map(([family, group]) => {
      const currentProduct = group.products
        .filter((product) => !product.hidden)
        .sort((left, right) =>
          Number(predecessorSkus.has(victronStockSku(left.sku))) - Number(predecessorSkus.has(victronStockSku(right.sku))) ||
          Number(left.sku.toUpperCase().endsWith('R')) - Number(right.sku.toUpperCase().endsWith('R')) ||
          left.sku.localeCompare(right.sku),
        )[0] || null;
      const dailyDemand = Math.max(group.sales30 / SALES_WINDOWS.recent, group.sales90 / SALES_WINDOWS.baseline);
      const minimumCoverDays = dailyDemand ? group.minimumStock / dailyDemand : null;
      const flags = {
        noSales90: group.sales90 <= 0,
        coverOver45: minimumCoverDays !== null && minimumCoverDays >= 45,
        noCurrentCatalogueSku: !currentProduct,
      };
      return {
        sku: currentProduct?.sku || predecessorSkusForFamily(successions.rows, family)[0] || family,
        name: currentProduct?.name || null,
        currentCatalogueSku: currentProduct?.sku || null,
        predecessorSkus: predecessorSkusForFamily(successions.rows, family),
        minimumStock: group.minimumStock,
        sales30: group.sales30,
        sales90: group.sales90,
        target14: Math.max(wholeUnits(dailyDemand * TARGET_COVER_DAYS), group.minimumStock),
        minimumCoverDays,
        flags,
      };
    });
  return NextResponse.json({ items: items.rows, review });
}

export async function PUT(request: Request) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const body = await request.json();
  const rawItems: unknown[] | null = Array.isArray(body?.items) ? body.items : null;
  if (!rawItems || rawItems.length > 500) return NextResponse.json({ error: 'Provide up to 500 stock-minimum changes.' }, { status: 400 });
  const items = rawItems.map((item) => {
    const value = item && typeof item === 'object' ? item as { sku?: unknown; minimumStock?: unknown } : {};
    return { sku: String(value.sku || '').trim().toUpperCase(), minimumStock: Number(value.minimumStock) };
  });
  if (items.some((item) => !/^[A-Z0-9-]{3,}$/.test(item.sku) || !Number.isInteger(item.minimumStock) || item.minimumStock < 0 || item.minimumStock > 10_000)) {
    return NextResponse.json({ error: 'Each SKU needs a whole-number minimum between 0 and 10,000.' }, { status: 400 });
  }
  await saveFamilyMinimums(items);
  return NextResponse.json({ ok: true, updated: items.length });
}

export async function PATCH(request: Request) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const body = await request.json();
  const sku = String(body?.sku || '').trim().toUpperCase();
  const minimumStock = body?.minimumStock;
  if (!/^[A-Z0-9-]{3,}$/.test(sku) || !Number.isInteger(minimumStock) || minimumStock < 0 || minimumStock > 10_000) {
    return NextResponse.json({ error: 'Provide a valid SKU and a whole-number minimum between 0 and 10,000.' }, { status: 400 });
  }
  await saveFamilyMinimums([{ sku, minimumStock }]);
  return NextResponse.json({ ok: true });
}
