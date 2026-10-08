import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response(null, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id < 1) return new Response(null, { status: 404 });
  try {
    const result = await pool.query(`SELECT d.document,d.revision FROM store_product_datasheets d
      JOIN products p ON p.id=d.product_id WHERE d.product_id=$1 AND p.details->>'storeManaged'='true'
      AND ($2::boolean OR COALESCE((p.details->>'hidden')::boolean,false)=false)`, [id, user.role === 'admin']);
    const row = result.rows[0];
    const requestedRevision = new URL(request.url).searchParams.get('v');
    if (!row || (requestedRevision && requestedRevision !== row.revision)) return new Response(null, { status: 404 });
    const headers = {
      'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="product-${id}-datasheet.pdf"`,
      'Cache-Control': 'private, no-cache', ETag: `"${row.revision}"`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
    };
    if (request.headers.get('if-none-match') === headers.ETag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(row.document), { headers });
  } catch (error) {
    return new Response(null, { status: (error as { code?: string }).code === '42P01' ? 404 : 503 });
  }
}
