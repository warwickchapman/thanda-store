import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const body = await request.json();
  const predecessorSku = String(body?.predecessorSku || '').trim().toUpperCase();
  const successorSku = String(body?.successorSku || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,}$/.test(predecessorSku) || !/^[A-Z0-9-]{3,}$/.test(successorSku) || predecessorSku === successorSku) {
    return NextResponse.json({ error: 'Provide different valid predecessor and successor SKUs.' }, { status: 400 });
  }
  const [successor, existing] = await Promise.all([
    pool.query(`SELECT 1 FROM products WHERE supplier = 'victron' AND UPPER(sku) = $1`, [successorSku]),
    pool.query<{ successor_sku: string }>('SELECT successor_sku FROM victron_sku_successions WHERE predecessor_sku = $1', [predecessorSku]),
  ]);
  if (!successor.rowCount) return NextResponse.json({ error: 'The successor must be a current Victron catalogue SKU.' }, { status: 400 });
  if (existing.rowCount && existing.rows[0].successor_sku.toUpperCase() !== successorSku) {
    return NextResponse.json({ error: `${predecessorSku} is already mapped to ${existing.rows[0].successor_sku}.` }, { status: 409 });
  }
  await pool.query(`
    INSERT INTO victron_sku_successions (predecessor_sku, successor_sku, source_description)
    VALUES ($1, $2, 'Manual entry by administrator')
    ON CONFLICT (predecessor_sku) DO UPDATE SET last_seen_at = NOW()
  `, [predecessorSku, successorSku]);
  return NextResponse.json({ ok: true, predecessorSku, successorSku });
}
