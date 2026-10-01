import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { accountKey, ensureVictronHttpSchema } from '@/lib/victron-http.mjs';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request) {
  const user = await currentUser();
  if (user?.role !== 'admin') return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
  const origin = process.env.PORTAL_BASE_URL || 'https://store.thanda.solar';
  if (request.headers.get('origin') !== new URL(origin).origin)
    return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const key = process.env.VICTRON_EORDER_API_KEY;
  if (!key) return NextResponse.json({ error: 'Catalogue credentials are not configured for this service.' }, { status: 503 });
  await ensureVictronHttpSchema(pool);
  const account = accountKey(key, process.env.VICTRON_EORDER_API_ROOT || 'https://eorder.victronenergy.com/api/v1');
  const state = (await pool.query(`SELECT MAX(blocked_until) AS until FROM victron_http_state WHERE account=$1 AND scope IN ('catalogue','account')`, [account])).rows[0];
  const schedule = (await pool.query('SELECT last_attempt_at FROM victron_catalogue_schedule WHERE id=true')).rows[0];
  const until = Math.max(new Date(state?.until || 0).getTime(), new Date(schedule?.last_attempt_at || 0).getTime() + 15 * 60_000);
  if (until > Date.now()) return NextResponse.json({ error: `Retry is paused until ${new Date(until).toISOString()}.`, retryAt: new Date(until).toISOString() }, { status: 429 });
  try {
    // Fixed local command, never user-supplied arguments. Script rechecks the
    // cooldown and acquires the same lock as scheduled catalogue runs.
    await promisify(execFile)(process.execPath, [path.join(process.cwd(), 'scripts/sync-victron-products.mjs'), '--manual'], { timeout: 50_000, maxBuffer: 512_000 });
    return NextResponse.json({ ok: true, message: 'Catalogue check finished. Review the updated status below; another running job or a cooldown may have deferred it.' });
  } catch {
    return NextResponse.json({ error: 'Catalogue retry did not complete. Review request activity and the latest source status below; do not repeatedly retry.' }, { status: 502 });
  }
}
