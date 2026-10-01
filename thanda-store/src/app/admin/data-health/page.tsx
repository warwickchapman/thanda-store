'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { DataSourceStatus, StockReviewItem } from '@/lib/data-freshness';
import { StockItemReview } from '@/components/admin/stock-item-review';
import { AdminMenu } from '@/components/admin/admin-menu';
import { VictronApiActivity, type VictronActivity } from '@/components/admin/victron-api-activity';

type HealthSource = DataSourceStatus;
const labels: Record<string, string> = { current: 'Current', stale: 'Update overdue', missing: 'Incomplete data', error: 'Update failed or incomplete', manual: 'Manual' };

function date(value: string | null) {
  return value ? new Date(value).toLocaleString('en-ZA') : 'Not recorded';
}

function Recovery({ source }: { source: HealthSource }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const issues = source.issues || [];
  const filtered = issues.filter(item => `${item.sku} ${item.name} ${item.reason}`.toLowerCase().includes(query.toLowerCase()));
  if (['current', 'manual'].includes(source.status)) return null;
  function downloadReport() {
    const report = [source.label, `Status: ${labels[source.status]}`, `Observation: ${date(source.observedAt)}`,
      `Last attempt: ${date(source.lastAttemptAt)}`, `Last success: ${date(source.lastSuccessAt)}`,
      source.lastError || '', ...(source.recovery || []), '',
      ...issues.map(item => `${item.sku}: ${item.reason}\n${item.remedy}`)].join('\n');
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `data-health-${source.id}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="mt-4 border-t border-zinc-200 pt-3">
    <h3 className="text-sm font-semibold">What to do</h3>
    <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-zinc-700">{source.recovery?.map(step => <li key={step}>{step}</li>)}</ul>
    <div className="mt-3 flex flex-wrap gap-4 text-sm font-semibold">
      {source.id === 'victron' && <a href="https://eorder.victronenergy.com/" target="_blank" rel="noreferrer" className="text-sky-800 underline">Open Victron E-Order</a>}
      {['thanda', 'sales'].includes(source.id) && <Link href="/admin/settings" className="text-sky-800 underline">Xero connection settings</Link>}
      {['thanda', 'accepted-quotes'].includes(source.id) && <Link href="/admin/replenishment" className="text-sky-800 underline">Open Replenishment</Link>}
      {source.id === 'victron-orders' && <Link href="/admin/victron-inbound" className="text-sky-800 underline">Review Inbound</Link>}
      <button type="button" onClick={downloadReport} className="text-sky-800 underline">Download diagnostic report</button>
    </div>
    {issues.length > 0 && <details className="mt-4">
      <summary className="cursor-pointer text-sm font-semibold">Review {issues.length} affected {issues.length === 1 ? 'SKU' : 'SKUs'}</summary>
      <input aria-label={`Find affected ${source.label} SKU`} placeholder="Find SKU, name or issue" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" />
      <ul className="mt-2 max-h-96 divide-y divide-zinc-200 overflow-y-auto">{filtered.slice(0, limit).map(item => <li key={item.sku} className="py-3 text-sm">
        <p><b>{item.sku}</b> · {item.name}</p>
        <p className="mt-1 text-amber-900">{item.reason}</p>
        <details className="mt-1"><summary className="cursor-pointer text-sky-800">How to resolve</summary><p className="mt-2 text-zinc-700">{item.remedy}</p></details>
      </li>)}</ul>
      {!filtered.length && <p className="mt-2 text-sm text-zinc-600">No affected SKUs match.</p>}
      {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 50)} className="mt-2 text-sm font-semibold text-sky-800 underline">Show more ({filtered.length - limit} remaining)</button>}
    </details>}
  </div>;
}

export default function DataHealthPage() {
  const [victron, setVictron] = useState<VictronActivity | null>(null);
  const [sources, setSources] = useState<HealthSource[]>([]);
  const [stockReviews, setStockReviews] = useState<StockReviewItem[]>([]);
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
      setVictron(data.victron || null);
      setStockReviews(data.stockReviews || []);
      setCheckedAt(data.checkedAt);
      setError('');
    }).catch(reason => { if (reason.name !== 'AbortError') setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const problems = sources.filter(source => !['current', 'manual'].includes(source.status));
  const sorted = [...sources].sort((a, b) => Number(['current', 'manual'].includes(a.status)) - Number(['current', 'manual'].includes(b.status)));
  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold">Data health</h1><p className="mt-2 text-sm text-zinc-600">Check which stock and planning sources need attention.</p></div><AdminMenu />
    </div>
    <button type="button" disabled={loading} onClick={() => { setLoading(true); setAttempt(value => value + 1); }} className="min-h-11 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 disabled:opacity-50">{loading ? 'Checking…' : 'Check status'}</button>
    <p className="text-xs text-zinc-500">This checks stored update records; it does not request new data from suppliers or Xero.{checkedAt && ` Status checked ${date(checkedAt)}.`}</p>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error} Use Check status to retry.</p>}
    {!loading && !error && <p role="status" className={`rounded-lg border p-4 text-sm ${problems.length ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-zinc-200 bg-white text-zinc-700'}`}>
      {problems.length ? `${problems.length} ${problems.length === 1 ? 'source needs' : 'sources need'} attention. Retained data may still be useful; review the warnings before relying on it.` : 'Scheduled sources are within their update windows. Manually maintained availability is listed separately.'}
    </p>}
    {!error && victron && <VictronApiActivity activity={victron} onChanged={() => setAttempt(value => value + 1)} />}
    {!error && <StockItemReview items={stockReviews} onChanged={() => setAttempt(value => value + 1)} />}
    <ul className="space-y-3">{sorted.map(source => <li id={source.id} key={source.id} className="scroll-mt-6 rounded-lg border border-zinc-200 bg-white p-4 text-zinc-950">
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
      <Recovery source={source} />
    </li>)}</ul>
  </div></main>;
}
