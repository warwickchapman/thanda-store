import pool from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id < 1) return new Response(null, { status: 404 });
  try {
    const result = await pool.query(`SELECT i.image,i.revision FROM store_product_images i
      JOIN products p ON p.id=i.product_id WHERE i.product_id=$1 AND p.details->>'storeManaged'='true'`, [id]);
    const row = result.rows[0];
    if (!row) return new Response(null, { status: 404 });
    const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600', ETag: `"${row.revision}"`, 'X-Content-Type-Options': 'nosniff' };
    if (request.headers.get('if-none-match') === headers.ETag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(row.image), { headers });
  } catch (error) {
    return new Response(null, { status: (error as { code?: string }).code === '42P01' ? 404 : 503 });
  }
}
