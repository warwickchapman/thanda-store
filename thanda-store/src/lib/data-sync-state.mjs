import { observationTime, safeSyncError } from './data-freshness.mjs';

// One bounded row per known source. This stores local job outcomes only and
// adds zero provider calls per run/day, no retries and no schedule changes.
export async function ensureDataSyncSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS data_sync_status (
    source_id TEXT PRIMARY KEY,
    last_started_at TIMESTAMPTZ,
    last_completed_at TIMESTAMPTZ,
    last_successful_at TIMESTAMPTZ,
    source_observed_at TIMESTAMPTZ,
    last_status TEXT,
    last_error TEXT,
    last_counts JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
}

export async function startDataSync(db, sourceId) {
  await ensureDataSyncSchema(db);
  // Retain a failure until a successful run replaces it, including while a
  // retry is running. Do not make an unresolved incident disappear on start.
  await db.query(`INSERT INTO data_sync_status (source_id, last_started_at, last_status)
    VALUES ($1, NOW(), 'running') ON CONFLICT (source_id) DO UPDATE SET
    last_started_at=NOW(), last_status=CASE WHEN data_sync_status.last_status IN ('failed','partial')
      THEN data_sync_status.last_status ELSE 'running' END`, [sourceId]);
}

export async function finishDataSync(db, sourceId, { status = 'success', observedAt = null, error = null, counts = {} } = {}) {
  const safeCounts = Object.fromEntries(Object.entries(counts).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)).slice(0, 16));
  await db.query(`UPDATE data_sync_status SET last_completed_at=NOW(), last_status=$2,
    last_successful_at=CASE WHEN $2='success' THEN NOW() ELSE last_successful_at END,
    source_observed_at=CASE WHEN $2='success' THEN $3::timestamptz ELSE source_observed_at END,
    last_error=$4, last_counts=$5::jsonb WHERE source_id=$1`,
  [sourceId, status, observationTime(observedAt), error ? safeSyncError(error) : null, JSON.stringify(safeCounts)]);
}
