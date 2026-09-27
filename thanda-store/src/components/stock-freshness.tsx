'use client';

import { useEffect, useState } from 'react';
import type { StockSourceStatus } from '@/lib/data-freshness';

export function observationLabel(value: string | null) {
  if (!value) return 'Update time unknown';
  return `Updated ${new Date(value).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

export function StockFreshness({ supplier, reloadKey }: { supplier: string; reloadKey: number }) {
  const [sources, setSources] = useState<StockSourceStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/catalogue-status', { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Stock update status unavailable');
        const data = await response.json();
        if (!Array.isArray(data.sources)) throw new Error('Invalid stock update status');
        setSources(data.sources);
        setFailed(false);
      }).catch(error => { if (error.name !== 'AbortError') setFailed(true); });
    return () => controller.abort();
  }, [reloadKey, attempt]);

  const visible = sources?.filter(source => source.id === 'thanda' || !supplier || supplier === 'home' || source.supplier === supplier);
  return <section aria-label="Stock updates" className="mb-6 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-600">
    {failed ? <div role="status" className="flex flex-wrap items-center justify-between gap-2 text-amber-800">
      <p>Stock update information is unavailable. Check availability with sales.</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)} className="min-h-11 font-semibold underline">Retry stock status</button>
    </div> : !sources ? <p>Checking stock update times…</p> : <ul className="flex flex-wrap gap-x-6 gap-y-3">
      {visible?.map(source => <li key={source.id} className="min-w-0">
        <p className="font-semibold text-zinc-800">{source.label}</p>
        {source.mode === 'manual' ? <p className="mt-1">{source.message}</p> : <>
          <p className="mt-1" title={source.observedAt ? new Date(source.observedAt).toLocaleString() : undefined}>{observationLabel(source.observedAt)}</p>
          {source.status !== 'current' && <p className="mt-1 max-w-xs font-medium text-amber-800">
            {source.status === 'stale' ? 'Update overdue — confirm availability.'
              : source.status === 'error' ? 'Latest update incomplete or failed — confirm availability.'
              : 'Some stock is unknown — confirm availability.'}
          </p>}
        </>}
      </li>)}
    </ul>}
  </section>;
}
