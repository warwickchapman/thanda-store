import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { validCustomerViewOrigin } from '@/lib/auth/impersonation-origin.mjs';
import { catalogueHub } from '@/lib/victron-catalogue-service.mjs';
import { itemCreationPreview } from '@/lib/xero-item-create.mjs';

export const runtime = 'nodejs';
export const maxDuration = 90;

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin' || user.impersonatedBy) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!validCustomerViewOrigin(request, { portalBaseUrl: process.env.PORTAL_BASE_URL, nodeEnv: process.env.NODE_ENV })) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || !['preview', 'create'].includes(body.action) || typeof body.sku !== 'string' || !/^[A-Z0-9-]{1,30}$/.test(body.sku)) return NextResponse.json({ error: 'Invalid item request' }, { status: 400 });
  try {
    const [products, successions] = await Promise.all([
      pool.query(`SELECT p.*,jsonb_build_object('decision',r.decision) AS "stockReview" FROM products p LEFT JOIN product_stock_reviews r ON r.supplier=p.supplier AND r.sku=p.sku WHERE p.supplier='victron' AND p.sku=$1`, [body.sku]),
      pool.query('SELECT predecessor_sku,successor_sku FROM victron_sku_successions'),
    ]);
    if (products.rows.length !== 1) return NextResponse.json({ error: 'Catalogue item not found' }, { status: 404 });
    const preview = itemCreationPreview(products.rows[0], successions.rows);
    if (!preview.eligible) return NextResponse.json({ error: preview.reason }, { status: 409 });
    if (body.action === 'preview') return NextResponse.json(preview);
    if (body.fingerprint !== preview.fingerprint) return NextResponse.json({ error: 'The price or catalogue evidence changed. Preview again before confirming.' }, { status: 409 });
    const response = await catalogueHub('thanda-solar', 'commands/victron-items', {
      method: 'POST', signal: AbortSignal.timeout(75000),
      headers: { 'Content-Type': 'application/json', 'X-Hub-Actor': String(user.id) },
      body: JSON.stringify({ ...preview.payload, requestId: preview.fingerprint }),
    });
    const result = await response.json();
    if (!response.ok) return NextResponse.json({ error: typeof result.detail === 'string' ? result.detail : 'Xero Hub could not complete creation. Check Data health before retrying.' }, { status: response.status, headers: response.headers.has('Retry-After') ? { 'Retry-After': response.headers.get('Retry-After')! } : {} });
    const item = result.Items?.[0];
    if (item?.Code !== body.sku || !item.ItemID) throw new Error('Unconfirmed item');
    // Do not assign QuantityOnHand, even from this response. Scheduled Xero stock import remains the authority.
    await pool.query(`UPDATE products SET details=details || jsonb_build_object('xeroCreatedItemId',$2::text,'xeroCreatedAt',NOW()) WHERE supplier='victron' AND sku=$1`, [body.sku, item.ItemID]);
    await pool.query(`INSERT INTO product_stock_review_events(supplier,sku,action,note,actor_id) VALUES('victron',$1,'create_xero',$2,$3)`, [body.sku, `Xero item ${item.ItemID}; cost ${preview.cost}; selling ${preview.selling}; no stock written`, user.id]);
    return NextResponse.json({ message: 'Product created in Xero. No stock quantities were written. The next scheduled Xero stock import will update its status here.' });
  } catch {
    return NextResponse.json({ error: 'Creation could not be confirmed. The Hub keeps a safe record of the attempt; check Xero and ask the maintainer to reconcile any uncertain outcome. Do not create a duplicate manually.' }, { status: 503 });
  }
}
