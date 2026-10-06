import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentUser } from '@/lib/auth/server';
import { validCustomerViewOrigin } from '@/lib/auth/impersonation-origin.mjs';
import { catalogueHub, refreshReview } from '@/lib/victron-catalogue-service.mjs';
import { ensureReviewSchema } from '@/lib/victron-catalogue-review.mjs';
export const runtime = 'nodejs';
export const maxDuration = 90;
async function admin() { const user = await currentUser(); return user?.role === 'admin' && !user.impersonatedBy ? user : null; }
export async function GET(request: Request) {
  if (!await admin()) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    await ensureReviewSchema(pool);
    const state = (await pool.query('SELECT * FROM victron_catalogue_review WHERE id=true')).rows[0];
    const overdue = !state.checked_at || Date.now() - new Date(state.checked_at).getTime() > 26 * 3600000;
    if (new URL(request.url).searchParams.get('summary') === '1') return NextResponse.json({ attention: overdue || Boolean(state.error) || (state.signature !== state.acknowledged_signature && state.rows.length > 0) });
    const events = (await pool.query('SELECT created_at,actor,action,company,sku,details FROM victron_catalogue_events ORDER BY id DESC LIMIT 50')).rows;
    return NextResponse.json({ ...state, history: undefined, overdue, events });
  } catch { return NextResponse.json({ error: 'Catalogue review is unavailable.' }, { status: 503 }); }
}
export async function POST(request: Request) {
  const user = await admin();
  if (!user || !validCustomerViewOrigin(request, { portalBaseUrl: process.env.PORTAL_BASE_URL, nodeEnv: process.env.NODE_ENV })) return NextResponse.json({ error: 'Same-origin administrator access required' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || !['refresh','acknowledge','apply','apply-batch','quarterly','archive-reviewed'].includes(body.action)) return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  try {
    await ensureReviewSchema(pool);
    if (body.action === 'refresh') {
      await refreshReview(pool);
      return NextResponse.json({ message: 'Compared saved supplier and Xero records.' });
    }
    if (body.action === 'acknowledge') {
      await pool.query('UPDATE victron_catalogue_review SET acknowledged_signature=signature WHERE id=true AND signature=$1', [body.signature]);
      return NextResponse.json({ message: 'Current alert acknowledged.' });
    }
    if (body.action === 'quarterly') {
      if (typeof body.note !== 'string' || body.note.trim().length < 10 || body.note.length > 4000) return NextResponse.json({ error: 'Record the quarter, source and discrepancies checked (10–4000 characters).' }, { status: 400 });
      await pool.query("INSERT INTO victron_catalogue_events(actor,action,details) VALUES($1,'quarterly',$2)", [String(user.id), JSON.stringify({ note: body.note.trim() })]);
      return NextResponse.json({ message: 'Quarterly sanity check recorded. E-Order remains the price authority.' });
    }
    // Rebuild from current saved evidence before every approval. No upstream Xero GET here.
    const fresh = await refreshReview(pool);
    if (body.action === 'apply-batch') {
      if (!Array.isArray(body.fingerprints) || !body.fingerprints.length || body.fingerprints.length > 50 || new Set(body.fingerprints).size !== body.fingerprints.length) return NextResponse.json({ error: 'Select 1–50 distinct cost changes.' }, { status: 400 });
      const selected = fresh.rows.filter(r => body.fingerprints.includes(r.fingerprint));
      if (selected.length !== body.fingerprints.length) return NextResponse.json({ code: 'STALE_SELECTION', error: `${body.fingerprints.length - selected.length} of ${body.fingerprints.length} selected proposals changed or are no longer available. No Xero updates were made. Review the latest comparison and select the costs again.` }, { status: 409 });
      if (selected.some(r => r.kind !== 'price')) return NextResponse.json({ code: 'STALE_SELECTION', error: 'This selection includes products that are not cost updates. No Xero updates were made. Select cost changes from the latest comparison.' }, { status: 409 });
      if (selected.some(r => r.company !== selected[0].company)) return NextResponse.json({ code: 'INVALID_SELECTION', error: 'The selection includes both Thanda and Sensible. No Xero updates were made. Select cost changes for one company at a time.' }, { status: 409 });
      const proposals = selected.map(row => ({ code: row.sku, name: row.name, cost: row.cost, list: row.list,
        observedAt: row.observedAt, action: row.kind, expectedItemId: row.itemId,
        expectedCost: row.previous, requestId: row.fingerprint }));
      const response = await catalogueHub(selected[0].company, 'commands/victron-costs', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Actor': String(user.id) }, body: JSON.stringify({ proposals }),
      });
      const result = await response.json();
      await pool.query('INSERT INTO victron_catalogue_events(actor,action,company,details) VALUES($1,$2,$3,$4)',
        [String(user.id), response.ok ? 'batch-applied' : 'batch-failed', selected[0].company, JSON.stringify({ changes: selected.map(r => ({ sku: r.sku, previous: r.previous, proposed: r.proposed })), result: response.ok ? result : { error: typeof result.detail === 'string' ? result.detail : 'Unconfirmed batch' } })]);
      if (!response.ok) return NextResponse.json({ error: typeof result.detail === 'string' ? result.detail : 'Batch could not be confirmed. Reconcile before retrying.' }, { status: response.status });
      await refreshReview(pool).catch(() => {});
      return NextResponse.json({ message: `Xero confirmed ${selected.length} cost updates.` });
    }
    const row = fresh.rows.find((r: { fingerprint: string }) => r.fingerprint === body.fingerprint);
    if (!row) return NextResponse.json({ code: 'STALE_SELECTION', error: 'This proposal changed or is no longer available. No Xero updates were made. Review the latest comparison before trying again.' }, { status: 409 });
    if (body.action === 'archive-reviewed') {
      if (row.kind !== 'archive' || !row.eligibleForArchiveReview || row.stock !== 0 || body.confirmed !== true) return NextResponse.json({ error: 'Archive checklist requires confirmed supplier retirement evidence, known zero stock, and your confirmation that open orders were checked and archival completed in Xero.' }, { status: 409 });
      await pool.query("INSERT INTO victron_catalogue_events(actor,action,company,sku,details) VALUES($1,'archive-reviewed',$2,$3,$4)", [String(user.id), row.company, row.sku, JSON.stringify(row)]);
      await refreshReview(pool).catch(() => {});
      return NextResponse.json({ message: 'Manual Xero archive completion recorded.' });
    }
    if (!['price','new'].includes(row.kind)) return NextResponse.json({ error: 'This item needs manual review.' }, { status: 409 });
    const response = await catalogueHub(row.company, 'commands/victron-items', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Actor': String(user.id) },
      body: JSON.stringify({ code: row.sku, name: row.name, cost: row.cost, list: row.list,
        observedAt: row.observedAt, action: row.kind, expectedItemId: row.itemId,
        expectedCost: row.previous, requestId: row.fingerprint }),
    });
    const result = await response.json();
    await pool.query('INSERT INTO victron_catalogue_events(actor,action,company,sku,details) VALUES($1,$2,$3,$4,$5)',
      [String(user.id), response.ok ? 'applied' : 'failed', row.company, row.sku, JSON.stringify({ changes: [{ sku: row.sku, previous: row.previous, proposed: row.proposed }], result: response.ok ? result : { error: typeof result.detail === 'string' ? result.detail : 'Hub could not confirm this action.' } })]);
    if (!response.ok) return NextResponse.json({ error: typeof result.detail === 'string' ? result.detail : 'Hub could not confirm this action. Check the audit before retrying.' }, { status: response.status });
    await refreshReview(pool).catch(() => {});
    return NextResponse.json({ message: 'Xero confirmed the item change.' });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Action could not be confirmed. Review the saved audit before retrying.' }, { status: 503 });
  }
}
