'use client';

import { useRef, useState } from 'react';
import type { StockReviewItem } from '@/lib/data-freshness';
import { stockReviewView } from '@/lib/stock-review-view.mjs';

type View = 'needs' | 'awaiting' | 'reviewed';
type Mode = 'actions' | 'do_not_stock';
const button = 'rounded-md border border-zinc-300 px-3 py-2 font-semibold disabled:opacity-50';
const date = (value: string) => new Date(value).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) + ' SAST';

export function StockItemReview({ items, onChanged }: { items: StockReviewItem[]; onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('needs');
  const [limit, setLimit] = useState(25);
  const [selected, setSelected] = useState<StockReviewItem | null>(null);
  const [mode, setMode] = useState<Mode>('actions');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const loraItems = items.filter(item => item.supplier === 'lora');
  const groups = { needs: loraItems.filter(i => stockReviewView(i) === 'needs'), awaiting: loraItems.filter(i => stockReviewView(i) === 'awaiting'), reviewed: loraItems.filter(i => stockReviewView(i) === 'reviewed') };
  const filtered = groups[view].filter(item => `${item.sku} ${item.name}`.toLowerCase().includes(query.toLowerCase()));

  function open(item: StockReviewItem) {
    if (item.supplier !== 'lora' || inFlight.current) return;
    setSelected(item); setMode('actions'); setNote(''); setError('');
    dialog.current?.showModal();
  }
  async function act(action: string) {
    if (!selected || selected.supplier !== 'lora' || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/admin/data-health/stock-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier: selected.supplier, sku: selected.sku, action, note }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save the review.');
      setMessage(`${selected.sku}: ${data.message}`); dialog.current?.close(); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to complete the review.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function choose(nextMode: Mode) { setMode(nextMode); setNote(''); setError(''); }

  if (!loraItems.length) return null;

  return <section className="rounded-lg border border-zinc-200 bg-white p-4">
    <h2 className="font-semibold">LoRa item review</h2>
    <p className="mt-2 text-sm text-zinc-600">Check LoRa products missing from Thanda&apos;s saved Xero list and record stocking decisions. This page does not change stock quantities.</p>
    {message && <p role="status" className="mt-3 rounded-md bg-sky-50 p-3 text-sm text-sky-900">{message}</p>}
    <div aria-label="Item review views" className="mt-4 flex flex-wrap gap-2">
      {([['needs', 'Missing from Xero'], ['awaiting', 'Awaiting Xero sync'], ['reviewed', 'Previously reviewed']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => { setView(key); setLimit(25); }} className={`${button} text-sm ${view === key ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-700'}`}>{label} ({groups[key].length})</button>)}
    </div>
    <input aria-label="Find missing Xero item" placeholder="Find SKU or name" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" />
    {view === 'awaiting' && <p className="mt-3 text-sm text-sky-900">A creation was confirmed for these products. They remain here until the normal Xero stock import finds them.</p>}
    {view === 'reviewed' && <p className="mt-3 text-sm text-zinc-600">These products have a previous local purchasing review or are now found in Xero. This does not mean they are archived in Xero.</p>}
    <ul className="mt-3 max-h-[32rem] divide-y divide-zinc-200 overflow-y-auto">{filtered.slice(0, limit).map(item => <li key={`${item.supplier}:${item.sku}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1 text-sm"><p className="font-semibold">{item.sku}</p><p className="text-zinc-600">{item.name}</p>
        {item.decision && <p className="mt-1 text-xs text-zinc-500">Saved purchasing decision: {item.decision === 'retired' ? 'discontinued' : 'do not stock'}{item.note && ` — ${item.note}`}{item.reviewedAt && ` · reviewed ${date(item.reviewedAt)}`}{item.xeroStatus !== 'missing' && ' · now found in Xero'}</p>}
        <p className="mt-1 text-xs text-zinc-500">Last saved Xero observation: {item.observedAt ? date(item.observedAt) : 'not recorded'}.</p>
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <button type="button" onClick={() => open(item)} className={button}>Other actions</button>
      </div>
    </li>)}</ul>
    {!filtered.length && <p className="mt-3 text-sm text-zinc-500">No items match this view.</p>}
    {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 25)} className="mt-3 text-sm font-semibold text-sky-800 underline">Show more ({filtered.length - limit} remaining)</button>}
    <dialog ref={dialog} aria-labelledby="stock-review-title" onCancel={event => { if (inFlight.current) event.preventDefault(); }} onClick={event => { if (!inFlight.current && event.target === event.currentTarget) dialog.current?.close(); }} className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-xl border border-zinc-300 bg-white p-5 text-sm text-zinc-900 shadow-xl backdrop:bg-black/30">
      {selected?.supplier === 'lora' && <>
        <div className="flex items-start justify-between gap-3"><h3 id="stock-review-title" className="text-lg font-bold">{mode === 'do_not_stock' ? 'Do not stock' : 'Other actions'}</h3><button type="button" disabled={busy} onClick={() => dialog.current?.close()} className="font-semibold text-sky-800 disabled:opacity-50">Close</button></div>
        <p className="mt-3 font-semibold">{selected.sku}</p><p className="text-zinc-600">{selected.name}</p>
        {mode === 'actions' ? <div className="mt-4 space-y-3">
          <button type="button" disabled={busy} onClick={() => void act('check')} className={`${button} w-full text-left`}>{busy ? 'Working…' : 'Check saved Xero list'}</button>
          <p className="text-xs text-zinc-500">Checks the latest imported list, not a live Xero request. Last observed: {selected.observedAt ? date(selected.observedAt) : 'not recorded'}.</p>
          {selected.xeroStatus === 'missing' && !selected.creationPending && <button type="button" disabled={busy} onClick={() => choose('do_not_stock')} className={`${button} w-full text-left`}>Do not stock</button>}
          {selected.decision && <div><p className="text-zinc-600">Saved decision: {selected.decision === 'retired' ? 'discontinued' : 'do not stock'}{selected.note ? ` — ${selected.note}` : ''}</p><button type="button" disabled={busy} onClick={() => void act('undo')} className="mt-2 font-semibold text-sky-800 underline">Undo saved decision</button></div>}
          <a href="https://go.xero.com/" target="_blank" rel="noreferrer" className="inline-block font-semibold text-sky-800 underline">Open Xero</a>
        </div> : <div className="mt-4">
          <p>This removes the missing-item alert for this LoRa SKU. Stock quantities and history are unchanged.</p>
          <details className="mt-3"><summary className="cursor-pointer text-zinc-600">Add a note (optional)</summary><textarea aria-label="Optional stocking note" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} className="mt-2 min-h-20 w-full rounded-md border border-zinc-300 p-2" /></details>
          <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => choose('actions')} className={button}>Back</button><button type="button" disabled={busy} onClick={() => void act(mode)} className={`${button} bg-zinc-900 text-white`}>{busy ? 'Saving…' : 'Save decision'}</button></div>
        </div>}
        {error && <p role="alert" className="mt-3 text-red-800">{error}</p>}
      </>}
    </dialog>
  </section>;
}
