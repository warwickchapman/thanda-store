import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';

export const runtime = 'nodejs';
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

type SubmittedLine = { sku: string; description: string; quantity: number; isStockItem: boolean };
function clean(value: unknown) { return String(value || '').trim(); }
function validLines(value: unknown): SubmittedLine[] | null {
  if (!Array.isArray(value)) return null;
  const bySku = new Map<string, SubmittedLine>();
  for (const item of value) {
    const sku = clean(item?.sku).toUpperCase();
    const description = clean(item?.description);
    const quantity = Number(item?.quantity);
    if (!/^[A-Z0-9-]{3,}$/.test(sku) || !description || !Number.isInteger(quantity) || quantity <= 0) return null;
    if (bySku.has(sku)) return null;
    bySku.set(sku, { sku, description, quantity, isStockItem: item?.isStockItem !== false });
  }
  return [...bySku.values()].length ? [...bySku.values()] : null;
}
async function requireAdmin() {
  const user = await currentUser();
  return user?.role === 'admin' ? user : null;
}

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const result = await pool.query(`
    SELECT o.id, o.supplier_order_number, o.customer_purchase_order, o.source, o.status, o.created_at, o.received_at,
      lines.lines, documents.documents
    FROM supplier_inbound_orders o
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', line.id, 'sku', line.sku, 'description', line.description,
        'orderedQuantity', line.ordered_quantity, 'receivedQuantity', line.received_quantity,
        'isStockItem', line.is_stock_item, 'receivedAt', line.received_at
      ) ORDER BY line.sku), '[]'::jsonb) AS lines
      FROM supplier_inbound_order_lines line WHERE line.inbound_order_id = o.id
    ) lines ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', document.id, 'filename', document.filename) ORDER BY document.id), '[]'::jsonb) AS documents
      FROM supplier_inbound_order_documents document WHERE document.inbound_order_id = o.id
    ) documents ON true
    WHERE o.supplier = 'victron'
    ORDER BY CASE WHEN o.status = 'open' THEN 0 ELSE 1 END, CASE WHEN o.source = 'backorder' THEN 0 ELSE 1 END, o.created_at DESC
  `);
  return NextResponse.json({ orders: result.rows });
}

export async function POST(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const formData = await request.formData();
  let order: { supplierOrderNumber?: string; customerPurchaseOrder?: string; lines?: unknown };
  try { order = JSON.parse(clean(formData.get('order'))); }
  catch { return NextResponse.json({ error: 'Order details are invalid.' }, { status: 400 }); }
  const supplierOrderNumber = clean(order.supplierOrderNumber);
  const customerPurchaseOrder = clean(order.customerPurchaseOrder) || null;
  const lines = validLines(order.lines);
  const files = formData.getAll('documents').filter((value): value is File => value instanceof File);
  if (!supplierOrderNumber || !lines) return NextResponse.json({ error: 'Provide a supplier order number and at least one valid line.' }, { status: 400 });
  if (files.length > 5) return NextResponse.json({ error: 'Upload at most five documents.' }, { status: 400 });
  const documents: Array<{ filename: string; content: Buffer; sha256: string }> = [];
  for (const file of files) {
    if (file.type !== 'application/pdf' || file.size > MAX_DOCUMENT_BYTES) return NextResponse.json({ error: `${file.name} must be a PDF smaller than 10 MB.` }, { status: 400 });
    const content = Buffer.from(await file.arrayBuffer());
    documents.push({ filename: file.name, content, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(`
      INSERT INTO supplier_inbound_orders (supplier, supplier_order_number, customer_purchase_order, created_by_user_id)
      VALUES ('victron', $1, $2, $3) RETURNING id
    `, [supplierOrderNumber, customerPurchaseOrder, user.id]);
    const orderId = inserted.rows[0].id;
    for (const line of lines) await client.query(`
      INSERT INTO supplier_inbound_order_lines (inbound_order_id, sku, description, ordered_quantity, is_stock_item)
      VALUES ($1, $2, $3, $4, $5)
    `, [orderId, line.sku, line.description, line.quantity, line.isStockItem]);
    for (const document of documents) await client.query(`
      INSERT INTO supplier_inbound_order_documents (inbound_order_id, filename, content_type, content, sha256)
      VALUES ($1, $2, 'application/pdf', $3, $4)
    `, [orderId, document.filename, document.content, document.sha256]);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, id: orderId }, { status: 201 });
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') return NextResponse.json({ error: 'That Victron order is already recorded.' }, { status: 409 });
    throw error;
  } finally { client.release(); }
}

export async function PATCH(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const body = await request.json();
  const orderId = Number(body.orderId);
  if (body.receiveAll === true) {
    if (!Number.isInteger(orderId)) return NextResponse.json({ error: 'A valid inbound order is required.' }, { status: 400 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = await client.query(`
        SELECT id, status FROM supplier_inbound_orders
        WHERE id = $1 AND supplier = 'victron' FOR UPDATE
      `, [orderId]);
      const row = order.rows[0];
      if (!row) { await client.query('ROLLBACK'); return NextResponse.json({ error: 'Inbound order not found.' }, { status: 404 }); }
      if (row.status === 'received') { await client.query('COMMIT'); return NextResponse.json({ ok: true, unchanged: true, complete: true }); }
      const received = await client.query(`
        UPDATE supplier_inbound_order_lines
        SET received_quantity = ordered_quantity, received_at = NOW(), received_by_user_id = $2
        WHERE inbound_order_id = $1 AND received_quantity < ordered_quantity
        RETURNING is_stock_item
      `, [orderId, user.id]);
      await client.query(`UPDATE supplier_inbound_orders SET status = 'received', received_at = NOW() WHERE id = $1`, [orderId]);
      if (received.rows.some((line) => line.is_stock_item)) await client.query(`
        INSERT INTO xero_stock_sync_state (id, refresh_requested_at, updated_at)
        VALUES (true, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET refresh_requested_at = NOW(), updated_at = NOW()
      `);
      await client.query('COMMIT');
      return NextResponse.json({ ok: true, complete: true, receivedLines: received.rowCount || 0 });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const lineId = Number(body.lineId);
  if (!Number.isInteger(lineId)) return NextResponse.json({ error: 'A valid receipt line is required.' }, { status: 400 });
  const partialQuantity = body.partialQuantity === undefined ? null : Number(body.partialQuantity);
  if (partialQuantity !== null && (!Number.isInteger(partialQuantity) || partialQuantity < 1)) return NextResponse.json({ error: 'Partial receipt must be a positive whole number.' }, { status: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const line = await client.query(`
      SELECT line.id, line.inbound_order_id, line.ordered_quantity, line.received_quantity, line.is_stock_item, o.status
      FROM supplier_inbound_order_lines line
      JOIN supplier_inbound_orders o ON o.id = line.inbound_order_id
      WHERE line.id = $1 AND o.supplier = 'victron' FOR UPDATE OF line, o
    `, [lineId]);
    const row = line.rows[0];
    if (!row) { await client.query('ROLLBACK'); return NextResponse.json({ error: 'Inbound line not found.' }, { status: 404 }); }
    if (row.status === 'received') { await client.query('COMMIT'); return NextResponse.json({ ok: true, unchanged: true }); }
    const outstandingQuantity = Number(row.ordered_quantity) - Number(row.received_quantity);
    if (partialQuantity !== null && partialQuantity > outstandingQuantity) { await client.query('ROLLBACK'); return NextResponse.json({ error: `Only ${outstandingQuantity} unit${outstandingQuantity === 1 ? '' : 's'} remain to be received.` }, { status: 400 }); }
    await client.query(`
      UPDATE supplier_inbound_order_lines
      SET received_quantity = received_quantity + $2, received_at = NOW(), received_by_user_id = $3
      WHERE id = $1
    `, [lineId, partialQuantity ?? outstandingQuantity, user.id]);
    const remaining = await client.query(`
      SELECT count(*)::int AS count FROM supplier_inbound_order_lines
      WHERE inbound_order_id = $1 AND is_stock_item = true AND received_quantity < ordered_quantity
    `, [row.inbound_order_id]);
    const complete = remaining.rows[0].count === 0;
    if (complete) await client.query(`UPDATE supplier_inbound_orders SET status = 'received', received_at = NOW() WHERE id = $1`, [row.inbound_order_id]);
    if (row.is_stock_item) await client.query(`
      INSERT INTO xero_stock_sync_state (id, refresh_requested_at, updated_at)
      VALUES (true, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET refresh_requested_at = NOW(), updated_at = NOW()
    `);
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, complete });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
