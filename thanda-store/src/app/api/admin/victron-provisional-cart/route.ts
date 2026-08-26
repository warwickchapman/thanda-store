import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';
import { parseVictronBasketHtml } from '@/lib/victron-provisional-cart';
import { importVictronCartProducts } from '@/lib/victron-cart-product-import';

async function requireAdmin() {
  const user = await currentUser();
  return user?.role === 'admin';
}

export async function POST(request: Request) {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const formData = await request.formData();
  const file = formData.get('cartHtml');
  if (!(file instanceof File) || file.size === 0 || file.size > 2_000_000) return NextResponse.json({ error: 'Upload one E-Order basket HTML file of up to 2 MB.' }, { status: 400 });
  let lines;
  try { lines = parseVictronBasketHtml(await file.text()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read this cart HTML.' }, { status: 400 }); }
  let imported: string[];
  try { imported = await importVictronCartProducts(lines.map((line) => line.sku)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to import new Victron cart products.' }, { status: 400 }); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM victron_provisional_cart_lines');
    for (const line of lines) await client.query('INSERT INTO victron_provisional_cart_lines (sku, quantity) VALUES ($1, $2)', [line.sku, line.quantity]);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, lineCount: lines.length, imported });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function DELETE() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  await pool.query('DELETE FROM victron_provisional_cart_lines');
  return NextResponse.json({ ok: true });
}
