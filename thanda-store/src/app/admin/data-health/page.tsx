'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { DataSourceStatus, StockReviewItem } from '@/lib/data-freshness';
import { StockItemReview } from '@/components/admin/stock-item-review';
import { AdminMenu } from '@/components/admin/admin-menu';
import { VictronApiActivity, type VictronActivity } from '@/components/admin/victron-api-activity';

type HealthSource = DataSourceStatus;
type StockRefresh = { pending: boolean; requestedAt: string | null; lastAttemptAt: string | null; error?: string };
const labels: Record<string, string> = { current: 'Current', stale: 'Update overdue', missing: 'Incomplete data', error: 'Update failed or incomplete', manual: 'Manual' };
const sourceGuidance: Record<string, { label: string; purpose: string; cadence: string }> = {
  thanda: { label: 'Thanda stock in Xero', purpose: 'Thanda’s own inventory balances, from its saved Xero records.', cadence: 'Stock imports run every 30 minutes.' },
  victron: { label: 'Victron supplier stock in ZA', purpose: 'Stock held by Victron’s South African warehouse, separate from Thanda’s own stock.', cadence: 'Supplier catalogue and stock checks run every four hours.' },
  renogy: { label: 'Renogy supplier stock in ZA', purpose: 'Stock available from Renogy’s South African warehouse.', cadence: 'Supplier checks run every five minutes.' },
  sales: { label: 'Thanda sales and credits', purpose: 'Sales and credit history used to calculate demand in Replenishment.', cadence: 'The daily history reconciliation runs at 08:00 South African time.' },
  'victron-orders': { label: 'Victron shipments and backorders', purpose: 'Supplier orders used to calculate what is still on the way.', cadence: 'Supplier order checks run every hour.' },
  'accepted-quotes': { label: 'Thanda accepted quote reservations', purpose: 'Stock reserved by accepted customer quotes in Thanda’s Xero organisation.', cadence: 'Quote reservation imports run every 30 minutes, after stock.' },
};
const healthy = (status: string) => ['current', 'manual'].includes(status);
const feedStatus = (source: HealthSource) => source.feedStatus || source.status;
const issueCount = (source: HealthSource) => source.mode === 'manual' ? 0 : source.actionableIssueCount ?? source.issues?.length ?? source.missingCount;
const needsAction = (source: HealthSource) => !healthy(feedStatus(source)) || issueCount(source) > 0
  || (source.lifecycleActionCount || 0) > 0 || Boolean(source.inventoryScopeMessage);

function date(value: string | null) {
  return value ? `${new Date(value).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} SAST` : 'Not recorded';
}

function supplierPause(source: HealthSource, activity: VictronActivity | null) {
  const scopes = source.id === 'victron' ? ['catalogue', 'account'] : source.id === 'victron-orders' ? ['orders', 'account'] : [];
  const checkedAt = Date.parse(activity?.checkedAt || '');
  const until = Math.max(0, ...(activity?.states || [])
    .filter(state => scopes.includes(state.scope))
    .map(state => Date.parse(state.blocked_until || ''))
    .filter(value => Number.isFinite(value) && value > checkedAt));
  return until ? new Date(until).toISOString() : null;
}

function Recovery({ source }: { source: HealthSource }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const issues = source.issues || [];
  const filtered = issues.filter(item => `${item.sku} ${item.name} ${item.reason}`.toLowerCase().includes(query.toLowerCase()));
  if (source.mode === 'manual') return null;
  function downloadReport() {
    const report = [source.label, `Update status: ${labels[feedStatus(source)]}`, `Data assessment: ${labels[source.status]}`, `Observation: ${date(source.observedAt)}`,
      `Last attempt: ${date(source.lastAttemptAt)}`, `Last success: ${date(source.lastSuccessAt)}`,
      source.lastError || '', source.inventoryScopeMessage || '', ...(source.recovery || []), '',
      ...issues.map(item => `${item.sku}: ${item.reason}\n${item.remedy}`),
      ...(source.awaitingStockImports || []).map(item => `${item.sku}: awaiting stock import; added ${date(item.createdAt)}`),
      ...(source.lifecycleItems || []).map(item => `${item.sku}: supplier catalogue absence observed ${date(item.observedAt)}`),
      `Pending catalogue actions: ${source.lifecycleActionCount ?? 'not confirmed'}`, source.lifecycleReviewMessage || ''].join('\n');
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `data-health-${source.id}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="mt-4 space-y-3 border-t border-zinc-200 pt-3">
    {issues.length > 0 && <details>
      <summary className="cursor-pointer text-sm font-semibold">{source.id === 'thanda' ? 'Stock records to check' : 'Affected records'} ({issues.length})</summary>
      <input aria-label={`Find affected ${source.label} SKU`} placeholder="Find SKU, name or issue" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" />
      <ul className="mt-2 max-h-96 divide-y divide-zinc-200 overflow-y-auto">{filtered.slice(0, limit).map(item => <li key={item.sku} className="py-3 text-sm">
        <p><b>{item.sku}</b> · {item.name}</p>
        <p className="mt-1 text-amber-900">{item.reason}</p>
        <p className="mt-2 text-zinc-700">{item.remedy}</p>
        {item.owner && <p className="mt-1 text-xs text-zinc-500">Who can help: {item.owner === 'bookkeeper' ? 'your bookkeeper' : 'the Store maintainer'}.</p>}
        {item.actionUrl && item.actionLabel && <Link href={item.actionUrl} className="mt-2 inline-block font-semibold text-sky-800 underline">{item.actionLabel}</Link>}
      </li>)}</ul>
      {!filtered.length && <p className="mt-2 text-sm text-zinc-600">No affected SKUs match.</p>}
      {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 50)} className="mt-2 text-sm font-semibold text-sky-800 underline">Show more ({filtered.length - limit} remaining)</button>}
    </details>}
    <details>
      <summary className="cursor-pointer text-sm font-semibold">Update details and diagnostic report</summary>
      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
        <div><dt className="text-zinc-500">Oldest source observation</dt><dd className="mt-1">{date(source.observedAt)}</dd></div>
        <div><dt className="text-zinc-500">Last local update attempt</dt><dd className="mt-1">{date(source.lastAttemptAt)}</dd></div>
        <div><dt className="text-zinc-500">Last successful local update</dt><dd className="mt-1">{date(source.lastSuccessAt)}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-zinc-600">{source.missingCount} unknown · {source.staleCount} overdue · {source.totalCount} {source.id === 'thanda' ? 'inventory articles assessed' : 'records checked'}</p>
      {source.lastError && <p className="mt-3 text-xs text-amber-800">{source.lastError}</p>}
      {source.inventoryScopeMessage && <p className="mt-3 text-xs text-amber-800">{source.inventoryScopeMessage}</p>}
      {!!source.recovery?.length && <><h3 className="mt-4 text-sm font-semibold">Recovery guidance</h3><ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-zinc-700">{source.recovery.map(step => <li key={step}>{step}</li>)}</ul></>}
      <button type="button" onClick={downloadReport} className="mt-4 text-sm font-semibold text-sky-800 underline">Download diagnostic report</button>
      {!!source.awaitingStockImports?.length && <p className="mt-3 text-xs text-zinc-600">Awaiting stock import: {source.awaitingStockImports.map(item => item.sku).join(', ')}.</p>}
      {!!source.lifecycleItems?.length && <p className="mt-3 text-xs text-zinc-600">Catalogue lifecycle records: {source.lifecycleItems.map(item => item.sku).join(', ')}.</p>}
    </details>
  </div>;
}

function NextStep({ source, pauseUntil = null }: { source: HealthSource; pauseUntil?: string | null }) {
  const status = feedStatus(source);
  const count = issueCount(source);
  const waiting = source.awaitingStockImportCount || 0;
  const lifecycle = source.lifecycleCount || 0;
  const pendingLifecycle = source.lifecycleActionCount || 0;
  const lifecycleUnknown = lifecycle > 0 && source.lifecycleActionCount == null;
  return <div className="mt-3 space-y-2 text-sm text-zinc-800">
    {pauseUntil && <p className="rounded-md bg-sky-50 p-3 text-sky-950"><span className="font-semibold">Supplier checks paused until {date(pauseUntil)}.</span> Victron asked us to wait. Use Check status after this time. Saved stock remains visible; do not retry before the pause ends.</p>}
    {!pauseUntil && !healthy(status) && <p><span className="font-semibold">Next step:</span> {status === 'missing'
      ? 'Ask the Store maintainer to check the first complete import for this source.'
      : 'Check status after the next scheduled update. If the update is still overdue or failed, send the diagnostic report to the Store maintainer.'}</p>}
    {count > 0 && <p><span className="font-semibold">{count} {count === 1 ? 'record needs' : 'records need'} checking.</span> Open {source.id === 'thanda' ? 'Stock records to check' : 'Affected records'} below for the cause and the person who can help. A missing quantity is not zero stock.</p>}
    {source.inventoryScopeMessage && <p><span className="font-semibold">Inventory requirement check is incomplete.</span> Ask the Store maintainer to check the saved stock, sales and order imports before relying on missing-stock decisions.</p>}
    {waiting > 0 && <p className="rounded-md bg-sky-50 p-3 text-sky-950"><span className="font-semibold">Waiting for stock import ({waiting}).</span> Xero confirmed these product additions. Allow the next stock import, then use Check status. Do not add them again. This does not confirm a stock quantity.</p>}
    {lifecycle > 0 && <p className="text-zinc-600">{lifecycle} {lifecycle === 1 ? 'product is' : 'products are'} absent from the last complete {source.id === 'victron' ? 'E-Order catalogue' : 'supplier catalogue'}. {source.id === 'renogy' && 'Absence does not confirm end of life.'}</p>}
    {pendingLifecycle > 0 && <p><span className="font-semibold">{pendingLifecycle} {pendingLifecycle === 1 ? 'product still needs' : 'products still need'} archive review.</span> Check remaining stock and outstanding orders in <Link href={source.lifecycleReviewUrl || '/admin/victron-catalogue?company=thanda-solar'} className="font-semibold text-sky-800 underline">Victron catalogue review</Link>.</p>}
    {lifecycleUnknown && <p className="text-zinc-600">{source.lifecycleReviewMessage || 'The saved catalogue comparison cannot confirm whether any archive work remains.'} <Link href={source.lifecycleReviewUrl || '/admin/victron-catalogue?company=thanda-solar'} className="font-semibold text-sky-800 underline">Check catalogue review</Link>.</p>}
    {lifecycle > 0 && pendingLifecycle === 0 && !lifecycleUnknown && <p className="text-zinc-600">No stock-data action is needed for these catalogue absences. {source.lifecycleReviewMessage}</p>}
    {!needsAction(source) && waiting === 0 && lifecycle === 0 && source.mode !== 'manual' && <p className="text-zinc-600">No action needed.</p>}
    {!healthy(status) && ['thanda', 'sales', 'accepted-quotes'].includes(source.id) && <Link href="/admin/settings" className="inline-block font-semibold text-sky-800 underline">Check Xero connection settings</Link>}
    {source.id === 'victron-orders' && needsAction(source) && <Link href="/admin/victron-inbound" className="inline-block font-semibold text-sky-800 underline">Review expected deliveries and receipts</Link>}
    {source.id === 'victron' && needsAction(source) && <a href="https://eorder.victronenergy.com/" target="_blank" rel="noreferrer" className="inline-block font-semibold text-sky-800 underline">Confirm availability in E-Order before ordering</a>}
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
  const [stockRefresh, setStockRefresh] = useState<StockRefresh | null>(null);
  const backgroundChecks = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/admin/data-health', { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load data health.');
      if (!Array.isArray(data.sources) || !data.sources.length) throw new Error('Unable to load data health.');
      setSources(data.sources);
      setVictron(data.victron || null);
      setStockReviews(data.stockReviews || []);
      setStockRefresh(data.stockRefresh || null);
      setCheckedAt(data.checkedAt);
      setError('');
    }).catch(reason => { if (reason.name !== 'AbortError') setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (!stockRefresh?.pending || backgroundChecks.current >= 3) return;
    // Three bounded rechecks of local status only; no provider polling loop.
    const timer = setTimeout(() => { backgroundChecks.current += 1; setAttempt(value => value + 1); }, 45_000);
    return () => clearTimeout(timer);
  }, [stockRefresh?.pending, attempt]);
  const problems = sources.filter(needsAction);
  const waitingCount = sources.reduce((sum, source) => sum + (source.awaitingStockImportCount || 0), 0);
  const unconfirmedCatalogue = sources.some(source => (source.lifecycleCount || 0) > 0 && source.lifecycleActionCount == null);
  const sorted = [...sources].sort((a, b) => Number(needsAction(b)) - Number(needsAction(a)));
  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold">Data health</h1><p className="mt-2 max-w-2xl text-sm text-zinc-600">See what needs attention in Thanda’s stock records and supplier updates. Sensible’s Xero catalogue is separate from the Store’s physical stock.</p><Link href="/admin/victron-catalogue?company=thanda-solar" className="mt-2 inline-block text-sm font-semibold text-sky-800 underline">Manage Victron products in catalogue review</Link></div><AdminMenu />
    </div>
    <button type="button" disabled={loading} onClick={() => { backgroundChecks.current = 0; setLoading(true); setAttempt(value => value + 1); }} className="min-h-11 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 disabled:opacity-50">{loading ? 'Checking…' : 'Check status'}</button>
    <p className="text-xs text-zinc-500">Check status reads saved data. It makes no new requests to Xero or suppliers. An overdue Thanda stock import may be queued using saved Xero records.</p>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error} Use Check status to retry.</p>}
    {!loading && !error && <p role="status" className={`rounded-lg border p-4 text-sm ${problems.length ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-zinc-200 bg-white text-zinc-700'}`}>
      {problems.length ? `${problems.length} ${problems.length === 1 ? 'source needs' : 'sources need'} attention. Follow the next steps below.` : stockRefresh?.error ? 'The Thanda stock update needs attention. See the message below.' : unconfirmedCatalogue ? 'Scheduled updates are current. Catalogue cleanup status has not been confirmed; see below.' : waitingCount || stockRefresh?.pending ? 'No other action is needed while the stock import completes.' : 'No action needed. Scheduled updates are current and no stock-record problems were found.'}
    </p>}
    {!error && stockRefresh?.pending && <p role="status" className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"><span className="font-semibold">Thanda stock update queued or running.</span> The import uses saved Xero records. This page will check progress a few times. You can also use Check status later{waitingCount > 0 ? '; do not add the products again.' : '.'}</p>}
    {!error && stockRefresh?.error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">The Thanda stock update needs attention: {stockRefresh.error} If this continues after the next scheduled import, contact the Store maintainer.</p>}
    {!error && <StockItemReview items={stockReviews} onChanged={() => setAttempt(value => value + 1)} />}
    <ul className="space-y-3">{sorted.map(source => <li id={source.id} key={source.id} className="scroll-mt-6 rounded-lg border border-zinc-200 bg-white p-4 text-zinc-950">
      <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-semibold">{sourceGuidance[source.id]?.label || source.label}</h2><span className={`text-xs font-semibold ${healthy(feedStatus(source)) ? 'text-zinc-600' : 'text-amber-800'}`}>{source.mode === 'manual' ? 'Manually maintained' : `Update: ${labels[feedStatus(source)]}`}</span></div>
      {sourceGuidance[source.id] && <p className="mt-2 text-sm text-zinc-600">{sourceGuidance[source.id].purpose}</p>}
      <p className="mt-2 text-sm text-zinc-600">{source.feedMessage || source.message}</p>
      {sourceGuidance[source.id] && <p className="mt-2 text-xs text-zinc-500">{sourceGuidance[source.id].cadence} {source.mode !== 'manual' && 'Use Check status after the next update.'}</p>}
      <NextStep source={source} pauseUntil={supplierPause(source, victron)} />
      {source.id === 'thanda' && (source.catalogueOnlyCount || 0) > 0 && <p className="mt-3 text-xs text-zinc-500">{source.catalogueOnlyCount} catalogue-only {source.catalogueOnlyCount === 1 ? 'article needs' : 'articles need'} no stock-record action. This does not confirm physical stock is zero.</p>}
      <Recovery source={source} />
    </li>)}</ul>
    {!error && victron && <details className="rounded-lg border border-zinc-200 bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">Victron update schedule, retries and request history</summary><div className="mt-4"><VictronApiActivity activity={victron} onChanged={() => setAttempt(value => value + 1)} /></div></details>}
    {checkedAt && <p className="text-xs text-zinc-500">Status checked {date(checkedAt)}. All times are South African time.</p>}
  </div></main>;
}
