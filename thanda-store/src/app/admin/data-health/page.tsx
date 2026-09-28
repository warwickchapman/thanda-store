'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { StockSourceStatus } from '@/lib/data-freshness';

type HealthSource = StockSourceStatus & { lastError?: string | null };
const labels: Record<string, string> = { current: 'Current', stale: 'Update overdue', missing: 'Incomplete data', error: 'Update failed or incomplete', manual: 'Manual' };

function date(value: string | null) {
  return value ? new Date(value).toLocaleString('en-ZA') : 'Not recorded';
}

export default function DataHealthPage() {
  const [sources, setSources] = useState<HealthSource[]>([]);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/admin/data-health', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load data health.');
      if (!Array.isArray(data.sources)) throw new Error('Unable to load data health.');
      setSources(data.sources);
      setCheckedAt(data.checkedAt);
      setError('');
    }).catch(reason => { if (reason.name !== 'AbortError') setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const problems = sources.filter(source => !['current', 'manual'].includes(source.status));
  const sorted = [...sources].sort((a, b) => Number(['current', 'manual'].includes(a.status)) - Number(['current', 'manual'].includes(b.status)));
  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
    <nav className="flex flex-wrap gap-4 text-sm font-semibold"><Link href="/admin/users" className="underline">Admin</Link><Link href="/admin/replenishment" className="underline">Inventory planning</Link><Link href="/" className="underline">Store</Link></nav>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold">Data health</h1><p className="mt-2 text-sm text-zinc-600">Check which stock and planning sources need attention.</p></div>
      <button type="button" disabled={loading} onClick={() => { setLoading(true); setAttempt(value => value + 1); }} className="min-h-11 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 disabled:opacity-50">{loading ? 'Checking…' : 'Check status'}</button>
    </div>
    <p className="text-xs text-zinc-500">This checks stored update records; it does not request new data from suppliers or Xero.{checkedAt && ` Status checked ${date(checkedAt)}.`}</p>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error} Use Check status to retry.</p>}
    {!loading && !error && <p role="status" className={`rounded-lg border p-4 text-sm ${problems.length ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-zinc-200 bg-white text-zinc-700'}`}>
      {problems.length ? `${problems.length} ${problems.length === 1 ? 'source needs' : 'sources need'} attention. Retained data may still be useful; review the warnings before relying on it.` : 'Scheduled sources are within their update windows. Manually maintained availability is listed separately.'}
    </p>}
    <ul className="space-y-3">{sorted.map(source => <li key={source.id} className="rounded-lg border border-zinc-200 bg-white p-4 text-zinc-950">
      <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-semibold">{source.label}</h2><span className={`text-xs font-semibold ${['current', 'manual'].includes(source.status) ? 'text-zinc-600' : 'text-amber-800'}`}>{labels[source.status]}</span></div>
      <p className="mt-2 text-sm text-zinc-600">{source.message}</p>
      {source.mode !== 'manual' && <>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
          <div><dt className="text-zinc-500">Oldest source observation</dt><dd className="mt-1">{date(source.observedAt)}</dd></div>
          <div><dt className="text-zinc-500">Last local update attempt</dt><dd className="mt-1">{date(source.lastAttemptAt)}</dd></div>
          <div><dt className="text-zinc-500">Last successful local update</dt><dd className="mt-1">{date(source.lastSuccessAt)}</dd></div>
        </dl>
        {(source.missingCount > 0 || source.staleCount > 0) && <p className="mt-3 text-xs text-amber-800">{source.missingCount} unknown · {source.staleCount} overdue · {source.totalCount} records checked</p>}
        {source.lastError && <p className="mt-3 text-xs text-amber-800">{source.lastError}</p>}
      </>}
    </li>)}</ul>
  </div></main>;
}
