import { randomBytes } from 'node:crypto';
import { catalogueHub } from './victron-catalogue-service.mjs';

const uncertainMessage = 'The result could not be confirmed. Do not repeat this update until the saved attempt has been reconciled with Xero.';
const uncertain = () => ({ status: 503, body: { code: 'UNKNOWN_OUTCOME', error: uncertainMessage } });

function confirmedItems(result, rows) {
  if (!Array.isArray(result?.Items) || result.Items.length !== rows.length) return false;
  const byCode = new Map(result.Items.map(item => [item?.Code, item]));
  return byCode.size === rows.length && new Set(result.Items.map(item => item?.ItemID)).size === rows.length && rows.every(row => {
    const item = byCode.get(row.sku);
    return item && typeof item.ItemID === 'string' && item.ItemID && !item.HasErrors && !item.ValidationErrors?.length
      && (row.kind === 'new' ? item.SalesDetails?.UnitPrice === row.list : item.ItemID === row.itemId)
      && item.PurchaseDetails?.UnitPrice === row.proposed;
  });
}

// One accepted click is one command. Persist its exact payload before sending it;
// the Hub owns live preflight, idempotency and blocking uncertain SKU outcomes.
/** @returns {Promise<{status: number, body: {code?: string, error?: string, message?: string}, headers?: Record<string, string>}>} */
export async function submitCatalogueCommand(pool, { actor, rows, batch = false }, request = catalogueHub) {
  const company = rows[0].company;
  const creating = rows[0].kind === 'new';
  const proposals = rows.map(row => ({ code: row.sku, name: row.name, cost: row.cost, list: row.list,
    observedAt: row.observedAt, action: row.kind, expectedItemId: row.itemId,
    expectedCost: row.previous, requestId: randomBytes(32).toString('hex') }));
  const path = batch ? (creating ? 'commands/victron-create' : 'commands/victron-costs') : 'commands/victron-items';
  const payload = batch ? { proposals } : proposals[0];
  const details = { changes: rows.map(row => ({ sku: row.sku, previous: row.previous, proposed: row.proposed })),
    request: { path, payload }, result: { error: 'Attempt recorded; no confirmed outcome yet. Reconcile before repeating this update.' } };
  let attemptId;
  try {
    attemptId = (await pool.query('INSERT INTO victron_catalogue_events(actor,action,company,sku,details) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [String(actor), batch ? 'batch-pending' : 'pending', company, batch ? null : rows[0].sku, JSON.stringify(details)])).rows[0]?.id;
    if (attemptId == null) throw new Error('Audit insert was not confirmed');
  } catch {
    return { status: 503, body: { code: 'NOT_SENT', error: 'The update was not sent because its audit record could not be saved. Please try again later.' } };
  }

  let outcome = uncertain();
  let result;
  let response;
  try {
    response = await request(company, path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Actor': String(actor) }, body: JSON.stringify(payload) });
    result = await response.json().catch(() => null);
    if (response.ok && confirmedItems(result, rows)) {
      const message = creating
        ? `Xero confirmed ${rows.length} new ${rows.length === 1 ? 'product' : 'products'} added.`
        : batch ? `Xero confirmed ${rows.length} cost updates.` : 'Xero confirmed the item change.';
      outcome = { status: 200, body: { message } };
    } else if (response.status === 503 && result?.code === 'DEFERRED' && typeof result.detail === 'string') {
      outcome = { status: 503, body: { code: 'DEFERRED', error: result.detail.slice(0, 1000) } };
    } else if (response.status >= 400 && response.status < 500 && typeof result?.detail === 'string') {
      const unknown = /uncertain|reconcil|unconfirmed/i.test(result.detail);
      outcome = { status: response.status, body: { code: unknown ? 'UNKNOWN_OUTCOME' : 'COMMAND_REJECTED', error: result.detail.slice(0, 1000) } };
    }
  } catch {
    // A lost/invalid response cannot establish whether Xero accepted a write.
  }
  const succeeded = outcome.status === 200;
  const action = `${batch ? 'batch-' : ''}${succeeded ? 'applied' : outcome.body.code === 'UNKNOWN_OUTCOME' ? 'unknown' : 'rejected'}`;
  try {
    await pool.query('UPDATE victron_catalogue_events SET action=$2,details=$3 WHERE id=$1',
      [attemptId, action, JSON.stringify({ ...details, result: succeeded ? result : { error: outcome.body.error, code: outcome.body.code, status: response?.status ?? null } })]);
  } catch {
    // The durable pending record survives; do not misreport a confirmed write.
    if (succeeded) outcome.body.message += ' The audit outcome could not be saved; the original attempt is recorded. Do not repeat the update.';
    else outcome.body.error += ' The original attempt is recorded, but its final audit status could not be saved.';
  }
  const retryAfter = response?.headers.get('Retry-After');
  return { ...outcome, headers: retryAfter ? { 'Retry-After': retryAfter } : {} };
}
