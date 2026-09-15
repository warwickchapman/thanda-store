#!/usr/bin/env node

// This monitor deliberately reads PostgreSQL only. It must never consume a
// Xero call merely to check Xero's remaining allowance.
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const ALERT_FILE = process.env.CODEX_ALERT_FILE || path.resolve(process.cwd(), '../runtime/CODEX_ALERTS.md');
const WARNING_REMAINING = 300;
const CRITICAL_REMAINING = 150;

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}

function sameSastDay(value) {
  if (!value) return false;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return formatter.format(new Date(value)) === formatter.format(new Date());
}

async function writeAlert(contents) {
  await fs.mkdir(path.dirname(ALERT_FILE), { recursive: true });
  const temporary = `${ALERT_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o640 });
  await fs.rename(temporary, ALERT_FILE);
}

async function main() {
  const db = new pg.Pool({ connectionString: required('DATABASE_URL') });
  try {
    const usage = await db.query(`
      SELECT day_limit_remaining, minute_limit_remaining, source, observed_at, next_allowed_at
      FROM xero_api_usage WHERE id = true
    `);
    const sources = await db.query(`
      SELECT source, COUNT(*)::int AS calls
      FROM xero_api_usage_log
      WHERE observed_at >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg'
      GROUP BY source ORDER BY calls DESC, source
    `).catch(() => ({ rows: [] }));
    const current = usage.rows[0];
    const remaining = Number(current?.day_limit_remaining);
    const fresh = current?.observed_at && sameSastDay(current.observed_at);
    let level = 'OK';
    let message = 'No fresh Xero allowance observation yet today. This monitor did not call Xero to obtain one.';
    if (fresh && Number.isFinite(remaining) && remaining <= 0) {
      level = 'CRITICAL';
      message = 'Xero daily allowance is exhausted. Do not run non-essential Xero work; use cached portal data only.';
    } else if (fresh && Number.isFinite(remaining) && remaining <= CRITICAL_REMAINING) {
      level = 'CRITICAL';
      message = `Only ${remaining} Xero calls remain. Non-essential Xero work must stay paused.`;
    } else if (fresh && Number.isFinite(remaining) && remaining <= WARNING_REMAINING) {
      level = 'WARNING';
      message = `Only ${remaining} Xero calls remain. Review source breakdown before approving further Xero work.`;
    } else if (fresh) {
      message = `${Number.isFinite(remaining) ? remaining : 'Unknown'} Xero calls remain according to the latest response headers.`;
    }
    const timestamp = new Date().toISOString();
    const sourceSummary = sources.rows.length
      ? sources.rows.map((entry) => `- ${entry.source || 'unknown'}: ${entry.calls} observed calls`).join('\n')
      : '- No source history recorded for the current SAST day.';
    await writeAlert(`# Codex Production Alerts\n\nStatus: **${level}**\nChecked: ${timestamp}\n\n${message}\n\n## Latest Xero observation\n\n- Observed: ${current?.observed_at || 'none'}\n- Source: ${current?.source || 'unknown'}\n- Remaining today: ${Number.isFinite(remaining) ? remaining : 'unknown'}\n- Remaining this minute: ${current?.minute_limit_remaining ?? 'unknown'}\n- Retry after: ${current?.next_allowed_at || 'none'}\n\n## Today by source\n\n${sourceSummary}\n\n## Required Codex action\n\nWhen status is WARNING or CRITICAL, do not add, retry, or manually trigger Xero work until the source has been investigated and the allowance is safe.\n`);
    console.log(`Wrote ${ALERT_FILE}: ${level}`);
  } finally {
    await db.end();
  }
}

main().catch(async (error) => {
  await writeAlert(`# Codex Production Alerts\n\nStatus: **WARNING**\n\nThe local Xero allowance monitor failed: ${String(error instanceof Error ? error.message : error).slice(0, 500)}\n\nDo not infer that the Xero allowance is healthy until this monitor is repaired.\n`).catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
