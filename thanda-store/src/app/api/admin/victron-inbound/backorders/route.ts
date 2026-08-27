import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { parseVictronBackordersHtml } from '@/lib/victron-provisional-cart';

export async function POST(request: Request) {
  const user = await currentUser();
  if (user?.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const file = (await request.formData()).get('backordersHtml');
  if (!(file instanceof File) || file.size === 0 || file.size > 2_000_000) return NextResponse.json({ error: 'Upload one saved E-Order Backorders HTML file of up to 2 MB.' }, { status: 400 });
  let orders;
  try { orders = parseVictronBackordersHtml(await file.text()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read this Backorders HTML.' }, { status: 400 }); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let created = 0; let updated = 0;
    for (const order of orders) {
      const existing = await client.query<{ id: number; status: string }>(`SELECT id, status FROM supplier_inbound_orders WHERE supplier = 'victron' AND supplier_order_number = $1 FOR UPDATE`, [order.orderNumber]);
      if (existing.rows[0]?.status === 'received') continue;
      const orderId = existing.rows[0]?.id || (await client.query<{ id: number }>(`INSERT INTO supplier_inbound_orders (supplier, supplier_order_number, created_by_user_id) VALUES ('victron', $1, $2) RETURNING id`, [order.orderNumber, user.id])).rows[0].id;
      if (existing.rows[0]) updated++; else created++;
      for (const line of order.lines) {
        await client.query(`INSERT INTO supplier_inbound_order_lines (inbound_order_id, sku, description, ordered_quantity, is_stock_item) VALUES ($1, $2, $3, $4, true) ON CONFLICT (inbound_order_id, sku) DO UPDATE SET description = EXCLUDED.description, ordered_quantity = supplier_inbound_order_lines.received_quantity + EXCLUDED.ordered_quantity`, [orderId, line.sku, line.description, line.quantity]);
      }
    }
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, created, updated, orderCount: orders.length });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
