import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { validCustomerViewOrigin as validAdminOrigin } from '@/lib/auth/impersonation-origin.mjs';
import { assertHubSnapshot, hubFetch } from '@/lib/xero/hub.mjs';
import { checkedXeroItem, STOCK_REVIEW_DECISIONS } from '@/lib/stock-review.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin' || user.impersonatedBy)
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!validAdminOrigin(request, { portalBaseUrl: process.env.PORTAL_BASE_URL, nodeEnv: process.env.NODE_ENV }))
    return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
  const body = await request.json().catch(() => null);
  const sku = typeof body?.sku === 'string' ? body.sku.trim().toUpperCase() : '';
  const supplier = body?.supplier;
  const action = body?.action;
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (!sku || sku.length > 100 || !['victron', 'lora'].includes(supplier)
      || ![...STOCK_REVIEW_DECISIONS, 'undo', 'check'].includes(action) || note.length > 1000
      || (action === 'retired' && (supplier !== 'victron' || !note)))
    return NextResponse.json({ error: 'Choose a valid item and action. A retirement decision requires a reason or supplier evidence.' }, { status: 400 });

  const client = await pool.connect();
  let locked = false;
  let inTransaction = false;
  try {
    const result = await client.query('SELECT supplier, sku, details FROM products WHERE supplier=$1 AND UPPER(sku)=$2', [supplier, sku]);
    if (result.rows.length !== 1) return NextResponse.json({ error: 'A unique catalogue item was not found.' }, { status: 404 });
    const product = result.rows[0];
    if (action === 'check') {
      // Same lock as the scheduled stock importer: never race a newer import.
      locked = Boolean((await client.query('SELECT pg_try_advisory_lock(742033) AS locked')).rows[0]?.locked);
      if (!locked) return NextResponse.json({ error: 'A stock import or item check is already running. Try again shortly.' }, { status: 409 });
      const recent = await client.query('SELECT MAX(last_checked_at) AS checked_at FROM product_stock_reviews');
      if (Date.now() - new Date(recent.rows[0]?.checked_at || 0).getTime() < 60_000)
        return NextResponse.json({ error: 'An item check ran less than a minute ago. Wait a minute before checking again.' }, { status: 429, headers: { 'Retry-After': '60' } });
      await client.query(`INSERT INTO product_stock_reviews (supplier,sku,last_checked_at) VALUES ($1,$2,NOW())
        ON CONFLICT (supplier,sku) DO UPDATE SET last_checked_at=NOW()`, [supplier, product.sku]);
      // One complete stored Items collection, zero direct Xero requests; no retries.
      const response = await hubFetch('/Items');
      if (!response.ok) return NextResponse.json({ error: `The saved Xero item list is unavailable (HTTP ${response.status}). Try after the next scheduled stock update.` }, { status: 502 });
      const payload = await response.json();
      assertHubSnapshot(payload);
      if (!Array.isArray(payload.Items)) throw new Error('Invalid Items collection');
      const checked = checkedXeroItem(payload.Items, sku, payload._hub.observed_at);
      await client.query('BEGIN');
      inTransaction = true;
      const updated = await client.query(`UPDATE products SET details=details || jsonb_build_object(
        'localStockOnHand',$3::integer,'xeroStockStatus',$4::text,'xeroStockSyncedAt',$5::text)
        WHERE supplier=$1 AND sku=$2
          AND (NULLIF(details->>'xeroStockSyncedAt','') IS NULL OR (details->>'xeroStockSyncedAt')::timestamptz <= $5::timestamptz)
        RETURNING sku`, [supplier, product.sku, checked.quantity, checked.status, checked.observedAt]);
      if (!updated.rowCount) {
        await client.query('ROLLBACK'); inTransaction = false;
        return NextResponse.json({ error: 'The Store already has a newer stock observation. Reload Data health.' }, { status: 409 });
      }
      await client.query(`INSERT INTO product_stock_review_events (supplier,sku,action,note,actor_id) VALUES ($1,$2,'check',$3,$4)`,
        [supplier, product.sku, `${checked.status}; source observed ${checked.observedAt}`, user.id]);
      await client.query('COMMIT'); inTransaction = false;
      const message = checked.status === 'missing'
        ? 'Not found in the saved Xero item list. If you just added it, wait for the Hub to observe it and check again.'
        : checked.status === 'untracked' ? 'Found in Xero, but it is not tracked as inventory. Ask the bookkeeper to review tracking.'
        : checked.quantity === null ? 'Found as a tracked item, but its saved stock quantity is missing.'
        : `Found as a tracked Xero item. Saved stock quantity: ${checked.quantity}.`;
      return NextResponse.json({ ok: true, message, observedAt: checked.observedAt, resolved: checked.status === 'tracked' && checked.quantity !== null });
    }
    await client.query('BEGIN'); inTransaction = true;
    const current = await client.query('SELECT details FROM products WHERE supplier=$1 AND sku=$2 FOR UPDATE', [supplier, product.sku]);
    if (action !== 'undo' && current.rows[0]?.details?.xeroStockStatus !== 'missing') {
      await client.query('ROLLBACK'); inTransaction = false;
      return NextResponse.json({ error: 'This item is no longer missing from Xero. Reload Data health to review its current evidence.' }, { status: 409 });
    }
    await client.query(`INSERT INTO product_stock_reviews (supplier,sku,decision,note,reviewed_by,reviewed_at)
      VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (supplier,sku) DO UPDATE
      SET decision=EXCLUDED.decision,note=EXCLUDED.note,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=NOW()`,
      [supplier, product.sku, action === 'undo' ? null : action, note, user.id]);
    await client.query(`INSERT INTO product_stock_review_events (supplier,sku,action,note,actor_id) VALUES ($1,$2,$3,$4,$5)`,
      [supplier, product.sku, action, note, user.id]);
    await client.query('COMMIT'); inTransaction = false;
    return NextResponse.json({ ok: true, message: action === 'undo' ? 'Decision removed. The item is back in the review queue.' : 'Decision saved. The missing-item alert is acknowledged; no stock quantity or history was changed.' });
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    console.error('Stock review failed', { code: (error as { code?: string }).code });
    return NextResponse.json({ error: 'The review could not be completed. No successful resolution was recorded; reload the page and try again.' }, { status: 503 });
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(742033)');
    client.release();
  }
}
