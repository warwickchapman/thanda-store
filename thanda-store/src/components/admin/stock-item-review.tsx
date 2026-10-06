'use client';

import { useRef, useState } from 'react';
import type { StockReviewItem } from '@/lib/data-freshness';
import { stockReviewView } from '@/lib/stock-review-view.mjs';

type View = 'needs' | 'awaiting' | 'reviewed';
type Mode = 'create' | 'actions' | 'do_not_stock' | 'retired';
type Preview = { cost: number; selling: number; fingerprint: string };
const button = 'rounded-md border border-zinc-300 px-3 py-2 font-semibold disabled:opacity-50';
const money = (value: number) => value.toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });

function Replacement({ item }: { item: StockReviewItem }) {
  if (!item.replaces?.length && !item.replacedBy?.length) return null;
  return <div className="mt-2 text-sm text-violet-900">
    {!!item.replaces?.length && <p><strong>Replaces {item.replaces.join(', ')}</strong></p>}
    {!!item.replacedBy?.length && <p><strong>Replaced by {item.replacedBy.join(', ')}</strong></p>}
  </div>;
}

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
  const [preview, setPreview] = useState<Preview | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const groups = { needs: items.filter(i => stockReviewView(i) === 'needs'), awaiting: items.filter(i => stockReviewView(i) === 'awaiting'), reviewed: items.filter(i => stockReviewView(i) === 'reviewed') };
  const filtered = groups[view].filter(item => `${item.sku} ${item.name} ${item.familySkus.join(' ')}`.toLowerCase().includes(query.toLowerCase()));

  async function create(item: StockReviewItem, action: 'preview' | 'create') {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/data-health/create-xero-item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, sku: item.sku, fingerprint: action === 'create' ? preview?.fingerprint : undefined }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to prepare item creation.');
      if (action === 'preview') setPreview(data);
      else { setMessage(`${item.sku}: ${data.message}`); dialog.current?.close(); setView('awaiting'); onChanged(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create item.'); setPreview(null); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function open(item: StockReviewItem, nextMode: 'create' | 'actions') {
    if (inFlight.current) return;
    setSelected(item); setMode(nextMode); setNote(''); setError(''); setPreview(null);
    dialog.current?.showModal();
    // Local preview only. Confirmation is always required to write to Xero.
    if (nextMode === 'create') void create(item, 'preview');
  }
  async function act(action: string) {
    if (!selected || inFlight.current) return;
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

  return <section className="rounded-lg border border-zinc-200 bg-white p-4">
    <h2 className="font-semibold">Review missing Xero items</h2>
    <p className="mt-2 text-sm text-zinc-600">Create a product in Xero or record why it is not needed. Stock quantities are never changed here.</p>
    {message && <p role="status" className="mt-3 rounded-md bg-sky-50 p-3 text-sm text-sky-900">{message}</p>}
    <div aria-label="Item review views" className="mt-4 flex flex-wrap gap-2">
      {([['needs', 'Needs action'], ['awaiting', 'Awaiting Xero sync'], ['reviewed', 'Reviewed / archived']] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => { setView(key); setLimit(25); }} className={`${button} text-sm ${view === key ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-700'}`}>{label} ({groups[key].length})</button>)}
    </div>
    <input aria-label="Find missing Xero item" placeholder="Find SKU or name" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm" />
    {view === 'awaiting' && <p className="mt-3 text-sm text-sky-900">These products were created in Xero. The next stock import will update their status. You can check the saved Xero list under Other actions.</p>}
    <ul className="mt-3 max-h-[32rem] divide-y divide-zinc-200 overflow-y-auto">{filtered.slice(0, limit).map(item => <li key={`${item.supplier}:${item.sku}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1 text-sm"><p className="font-semibold">{item.sku}</p><p className="text-zinc-600">{item.name}</p><Replacement item={item} />
        {item.decision && <p className="mt-1 text-xs text-zinc-500">{item.decision === 'retired' ? 'Marked as discontinued' : 'Do not stock'}{item.xeroStatus !== 'missing' && ' · now found in Xero'}</p>}
        {item.purchasingRetiredReason && <p className="mt-1 text-xs text-amber-900">{item.purchasingRetiredReason}{item.purchasingRestored && ' Restored for purchasing review.'}</p>}
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        {item.supplier === 'victron' && !item.decision && !item.purchasingRetiredReason && !item.creationPending && item.xeroStatus === 'missing' && <button type="button" onClick={() => open(item, 'create')} className={`${button} border-sky-300 text-sky-900`}>Create in Xero</button>}
        <button type="button" onClick={() => open(item, 'actions')} className={button}>Other actions</button>
      </div>
    </li>)}</ul>
    {!filtered.length && <p className="mt-3 text-sm text-zinc-500">No items match this view.</p>}
    {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 25)} className="mt-3 text-sm font-semibold text-sky-800 underline">Show more ({filtered.length - limit} remaining)</button>}
    <dialog ref={dialog} aria-labelledby="stock-review-title" onCancel={event => { if (inFlight.current) event.preventDefault(); }} onClick={event => { if (!inFlight.current && event.target === event.currentTarget) dialog.current?.close(); }} className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-xl border border-zinc-300 bg-white p-5 text-sm text-zinc-900 shadow-xl backdrop:bg-black/30">
      {selected && <>
        <div className="flex items-start justify-between gap-3"><h3 id="stock-review-title" className="text-lg font-bold">{mode === 'create' ? 'Create product in Xero' : mode === 'do_not_stock' ? 'Do not stock' : mode === 'retired' ? 'Mark as discontinued' : 'Other actions'}</h3><button type="button" disabled={busy} onClick={() => dialog.current?.close()} className="font-semibold text-sky-800 disabled:opacity-50">Close</button></div>
        <p className="mt-3 font-semibold">{selected.sku}</p><p className="text-zinc-600">{selected.name}</p>
        <Replacement item={selected} />
        {(!!selected.replaces?.length || !!selected.replacedBy?.length) && <p className="mt-1 text-xs text-zinc-500">Sales and stock across these replacement codes are included in replenishment planning.</p>}
        {mode === 'create' ? <>
          {busy && !preview && <p role="status" className="mt-4">Loading saved prices…</p>}
          {preview && <dl className="mt-4 grid grid-cols-2 gap-4 rounded-md bg-sky-50 p-4"><div><dt className="text-zinc-600">Cost price</dt><dd className="mt-1 text-lg font-bold">{money(preview.cost)}</dd></div><div><dt className="text-zinc-600">Selling price</dt><dd className="mt-1 text-lg font-bold">{money(preview.selling)}</dd></div></dl>}
          <p className="mt-2 text-xs text-zinc-500">Prices exclude VAT.</p>
          <p className="mt-4 font-semibold">No stock quantities will be changed.</p>
          <details className="mt-3 text-zinc-600"><summary className="cursor-pointer">Accounting details</summary><p className="mt-2">Creates a tracked product definition. Cost is the normal E-Order price; selling price is the verified E-Order ZAR list price. Victron accounts: inventory 631, cost of sales 311, sales 201. No opening balance, adjustment or receipt is sent.</p></details>
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => dialog.current?.close()} className={button}>Cancel</button><button type="button" disabled={busy || !preview} onClick={() => void create(selected, 'create')} className={`${button} bg-zinc-900 text-white`}>{busy && preview ? 'Creating…' : 'Create product'}</button></div>
          {error && !busy && <button type="button" onClick={() => void create(selected, 'preview')} className="mt-3 font-semibold text-sky-800 underline">Reload price preview</button>}
        </> : mode === 'actions' ? <div className="mt-4 space-y-3">
          <button type="button" disabled={busy} onClick={() => void act('check')} className={`${button} w-full text-left`}>{busy ? 'Working…' : 'Check saved Xero list'}</button>
          <p className="text-xs text-zinc-500">Checks the latest imported list, not a live Xero request. Last observed: {selected.observedAt ? new Date(selected.observedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' }) + ' SAST' : 'not recorded'}.</p>
          {selected.xeroStatus === 'missing' && !selected.creationPending && <>
            <button type="button" disabled={busy} onClick={() => choose('do_not_stock')} className={`${button} w-full text-left`}>Do not stock</button>
            {selected.supplier === 'victron' && <button type="button" disabled={busy} onClick={() => choose('retired')} className={`${button} w-full text-left`}>Mark as discontinued</button>}
          </>}
          {selected.purchasingRetiredReason && <div className="rounded-md bg-amber-50 p-3"><p>{selected.purchasingRetiredReason}</p><button type="button" disabled={busy} onClick={() => void act(selected.purchasingRestored ? 'archive_purchasing' : 'restore_purchasing')} className="mt-2 font-semibold text-sky-800 underline">{selected.purchasingRestored ? 'Archive from purchasing again' : 'Restore to purchasing review'}</button></div>}
          {selected.decision && <div><p className="text-zinc-600">Saved decision: {selected.decision === 'retired' ? 'discontinued' : 'do not stock'}{selected.note ? ` — ${selected.note}` : ''}</p><button type="button" disabled={busy} onClick={() => void act('undo')} className="mt-2 font-semibold text-sky-800 underline">Undo saved decision</button></div>}
          <a href="https://go.xero.com/" target="_blank" rel="noreferrer" className="inline-block font-semibold text-sky-800 underline">Open Xero</a>
        </div> : <div className="mt-4">
          <p>This removes the missing-item alert for this SKU only—not its predecessor or replacement. Stock quantities and history are unchanged.</p>
          {mode === 'retired' ? <><p className="mt-3 text-amber-900">Confirm with the supplier. Missing from Xero alone does not mean discontinued.</p><label htmlFor="stock-review-note" className="mt-3 block font-semibold">Reason / supplier evidence (required)</label><textarea id="stock-review-note" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} className="mt-1 min-h-20 w-full rounded-md border border-zinc-300 p-2" /></> : <details className="mt-3"><summary className="cursor-pointer text-zinc-600">Add a note (optional)</summary><textarea aria-label="Optional stocking note" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} className="mt-2 min-h-20 w-full rounded-md border border-zinc-300 p-2" /></details>}
          <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={() => choose('actions')} className={button}>Back</button><button type="button" disabled={busy || (mode === 'retired' && !note.trim())} onClick={() => void act(mode)} className={`${button} bg-zinc-900 text-white`}>{busy ? 'Saving…' : 'Save decision'}</button></div>
        </div>}
        {error && <p role="alert" className="mt-3 text-red-800">{error}</p>}
      </>}
    </dialog>
  </section>;
}
