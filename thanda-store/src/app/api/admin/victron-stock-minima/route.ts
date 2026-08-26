import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { familyMemberSkus } from '@/lib/victron-sku-family.mjs';

type Succession = { predecessor_sku: string; successor_sku: string };

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
  const result = await pool.query(`
    SELECT p.sku, p.name, COALESCE(m.minimum_stock, 0) AS minimum_stock, m.source
    FROM products p
    LEFT JOIN victron_stock_minima m ON UPPER(m.sku) = UPPER(p.sku)
    WHERE p.supplier = 'victron' AND COALESCE((p.details->>'hidden')::boolean, false) = false
    ORDER BY p.name, p.sku
  `);
  return NextResponse.json({ items: result.rows });
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
