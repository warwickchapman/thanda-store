import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { ensureAuthSchema } from '@/lib/auth/schema';

export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ documentId: string }> }) {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  await ensureAuthSchema();
  const { documentId } = await context.params;
  const id = Number(documentId);
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
  const result = await pool.query(`
    SELECT document.filename, document.content
    FROM supplier_inbound_order_documents document
    JOIN supplier_inbound_orders inbound ON inbound.id = document.inbound_order_id
    WHERE document.id = $1 AND inbound.supplier = 'victron'
  `, [id]);
  const document = result.rows[0];
  if (!document) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
  return new NextResponse(document.content, { headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${String(document.filename).replace(/["\\r\\n]/g, '_')}"`,
    'Cache-Control': 'private, no-store',
  } });
}
