'use client';
import { useState } from 'react';

export type VictronActivity = {
  checkedAt: string;
  states: Array<{ scope: string; blocked_until: string | null; last_status: number | null; quota: Record<string, string> }>;
  usage: Array<{ component: string; trigger: string; endpoint: string; requests: number; throttled: number; skipped: number }>;
  recent: Array<{ requested_at: string; component: string; endpoint: string; status: number | null; outcome: string; error_kind: string | null; retry_at: string | null }>;
  schedule: { last_attempt_at: string | null; next_scheduled_at: string | null } | null;
};
const date = (value: string) => new Date(value).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
const errorLabels: Record<string, string> = {
  timeout: 'Request timed out',
  redirect_refused: 'Redirect refused',
  dns: 'DNS lookup failed',
  tls: 'TLS or certificate failed',
  connection: 'Connection failed',
  response_body: 'Response interrupted',
  request_failed: 'Request failed',
};
export function VictronApiActivity({ activity, onChanged }: { activity: VictronActivity; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const checkedAt = Date.parse(activity.checkedAt);
  const blocked = activity.states.filter(state => state.blocked_until && Date.parse(state.blocked_until) > checkedAt);
  const catalogueUntil = Math.max(0, ...blocked.filter(state => ['catalogue', 'account'].includes(state.scope)).map(state => Date.parse(state.blocked_until!)), activity.schedule?.last_attempt_at ? Date.parse(activity.schedule.last_attempt_at) + 15 * 60_000 : 0);
  async function retry() {
    setBusy(true);
    try {
      const response = await fetch('/api/admin/data-health/victron-retry', { method: 'POST' });
      const body = await response.json();
      setMessage(body.message || body.error || 'Check completed.');
    } catch { setMessage('Unable to check catalogue. Use Check status before retrying.'); }
    finally { setBusy(false); onChanged(); }
  }
  return <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
    <h2 className="font-semibold">Victron API activity</h2>
    <p className="mt-2 text-zinc-600">Catalogue: every four hours. Shipments/backorders: hourly. Stored request history only; viewing this panel makes no Victron calls. Times are South African time.</p>
    {blocked.map(state => <p key={state.scope} className="mt-2 text-amber-900">{state.scope}: paused until {date(state.blocked_until!)} because Victron requested a cooldown.</p>)}
    <p className="mt-2">Next catalogue eligibility: {activity.schedule?.next_scheduled_at ? date(new Date(Math.max(Date.parse(activity.schedule.next_scheduled_at), catalogueUntil)).toISOString()) : 'Next scheduled run'}. The four-hour timer runs at 02:00, 06:00, 10:00, 14:00, 18:00 and 22:00 SAST, shortly after the hour; it skips while paused.</p>
    <button type="button" disabled={busy || catalogueUntil > checkedAt} onClick={() => void retry()} className="mt-3 rounded border px-3 py-2 font-semibold disabled:opacity-50">{busy ? 'Checking catalogue…' : 'Retry catalogue'}</button>
    <p className="mt-1 text-xs text-zinc-600">Retry makes live requests. At least 15 minutes between attempts; supplier cooldowns cannot be bypassed. Use Check status after a cooldown expires.</p>
    {message && <p role="status" className="mt-2">{message}</p>}
    <details className="mt-3"><summary className="cursor-pointer font-semibold">Request breakdown · last 24 hours</summary>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Component / trigger</th><th>Endpoint</th><th>Requests</th><th>429s</th><th>Locally skipped</th></tr></thead><tbody>
        {activity.usage.map(row => <tr key={`${row.component}:${row.trigger}:${row.endpoint}`} className="border-t"><td className="py-2">{row.component} / {row.trigger}</td><td>{row.endpoint}</td><td>{row.requests}</td><td>{row.throttled}</td><td>{row.skipped}</td></tr>)}
      </tbody></table></div>
      {!activity.usage.length && <p>No requests recorded since monitoring was enabled.</p>}
      <p className="mt-2">Victron’s account allowance is not yet verified. Returned limit headers are retained below; request counts are not a claimed remaining quota.</p>
      {activity.states.filter(state => Object.keys(state.quota).length).map(state => <p key={state.scope} className="mt-1 break-words text-xs">{state.scope}: {Object.entries(state.quota).map(([key, value]) => `${key}: ${value}`).join(' · ')}</p>)}
      <ul className="mt-2">{activity.recent.map((row, index) => <li key={index}>{date(row.requested_at)} · {row.component} / {row.endpoint} · {row.status || (row.outcome === 'transport_error' ? row.error_kind ? errorLabels[row.error_kind] || 'Request failed' : 'Transport failed (cause not recorded)' : row.outcome === 'internal_error' ? 'Local processing failed' : row.outcome)}{row.retry_at && ` · retry after ${date(row.retry_at)}`}</li>)}</ul>
    </details>
  </section>;
}
