const STALE_MS = 35 * 60_000;
const COALESCE_MS = 15 * 60_000;
const FUTURE_ALLOWANCE_MS = 5 * 60_000;

const time = value => value ? Date.parse(value) : NaN;
const view = row => ({
  pending: Boolean(row?.refresh_requested_at),
  requestedAt: row?.refresh_requested_at || null,
  lastAttemptAt: row?.last_started_at || null,
});

/** Queue the existing five-minute cached-Hub importer; never contact Xero. */
export async function requestLocalStockRefresh(db, { afterChange = false } = {}) {
  const { rows } = await db.query(`INSERT INTO xero_stock_sync_state(id,refresh_requested_at,updated_at)
    VALUES(true,now(),now()) ON CONFLICT(id) DO UPDATE SET
      refresh_requested_at=${afterChange ? 'GREATEST(xero_stock_sync_state.refresh_requested_at,EXCLUDED.refresh_requested_at)' : 'COALESCE(xero_stock_sync_state.refresh_requested_at,EXCLUDED.refresh_requested_at)'},
      updated_at=now() RETURNING refresh_requested_at,last_started_at`);
  return view(rows[0]);
}

/** Admin visits inspect local evidence and coalesce a stale-cache request. */
export async function queueStaleLocalStockRefresh(db, { now = Date.now() } = {}) {
  const { rows } = await db.query(`SELECT s.refresh_requested_at,s.last_started_at,e.observed_at
    FROM (VALUES(true)) singleton(id)
    LEFT JOIN xero_stock_sync_state s ON s.id=singleton.id
    LEFT JOIN thanda_inventory_evidence e ON e.id=singleton.id`);
  const row = rows[0];
  const checkedAt = Number(new Date(now));
  const observedAt = time(row?.observed_at);
  const lastAttemptAt = time(row?.last_started_at);
  const validObservation = Number.isFinite(observedAt) && observedAt <= checkedAt + FUTURE_ALLOWANCE_MS;
  const validAttempt = Number.isFinite(lastAttemptAt) && lastAttemptAt <= checkedAt + FUTURE_ALLOWANCE_MS;
  if (!row?.refresh_requested_at && (!validObservation || checkedAt - observedAt > STALE_MS)
    && (!validAttempt || checkedAt - lastAttemptAt >= COALESCE_MS)) {
    return requestLocalStockRefresh(db);
  }
  return view(row);
}
