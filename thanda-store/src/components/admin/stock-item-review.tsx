'use client';

import { useRef, useState } from 'react';
import type { StockReviewItem } from '@/lib/data-freshness';

export function StockItemReview({ items, onChanged }: { items: StockReviewItem[]; onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const [showReviewed, setShowReviewed] = useState(false);
  const [limit, setLimit] = useState(25);
  const [selected, setSelected] = useState<StockReviewItem | null>(null);
  const [decision, setDecision] = useState('do_not_stock');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ cost: number; selling: number; fingerprint: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = items.filter(item => item.xeroStatus === 'missing' && !item.active && !item.creationPending);
  const reviewed = items.filter(item => item.decision || item.purchasingRetiredReason || item.creationPending);
  const filtered = (showReviewed ? reviewed : pending).filter(item => `${item.sku} ${item.name} ${item.familySkus.join(' ')}`.toLowerCase().includes(query.toLowerCase()));

  function open(item: StockReviewItem) {
    setSelected(item); setDecision(item.decision || 'do_not_stock'); setNote(item.note); setError(''); setPreview(null);
    dialog.current?.showModal();
  }
  async function create(action: 'preview' | 'create') {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/data-health/create-xero-item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, sku: selected.sku, fingerprint: preview?.fingerprint }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to prepare item creation.');
      if (action === 'preview') setPreview(data);
      else { setMessage(`${selected.sku}: ${data.message}`); dialog.current?.close(); onChanged(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create item.'); setPreview(null); }
    finally { setBusy(false); }
  }
  async function act(action: string) {
    if (!selected || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/admin/data-health/stock-review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier: selected.supplier, sku: selected.sku, action, note }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save the review.');
      setMessage(`${selected.sku}: ${data.message}${data.observedAt ? ` Xero list observed ${new Date(data.observedAt).toLocaleString('en-ZA')}.` : ''}`);
      dialog.current?.close();
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to complete the review.'); }
    finally { setBusy(false); }
  }
  return <section className="rounded-lg border border-zinc-200 bg-white p-4">
    <h2 className="font-semibold">Review missing Xero items · {pending.length} to review</h2>
    <p className="mt-2 text-sm text-zinc-600">Review and create eligible products in Xero, or record a stocking decision. Product creation never writes stock quantities. Retired products remain in Reviewed / archived with their history intact.</p>
    {message && <p role="status" className="mt-3 rounded-md bg-sky-50 p-3 text-sm text-sky-900">{message}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <input aria-label="Find missing Xero item" placeholder="Find SKU, name or family" value={query} onChange={event => { setQuery(event.target.value); setLimit(25); }} className="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm" />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showReviewed} onChange={event => { setShowReviewed(event.target.checked); setLimit(25); }} />Reviewed / archived ({reviewed.length})</label>
    </div>
    <ul className="mt-3 max-h-[32rem] divide-y divide-zinc-200 overflow-y-auto">{filtered.slice(0, limit).map(item => <li key={`${item.supplier}:${item.sku}`} className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0 text-sm"><p className="font-semibold">{item.sku}</p><p className="text-zinc-600">{item.name}</p>
        {item.decision && <p className="mt-1 text-xs text-zinc-500">{item.decision === 'retired' ? 'No longer supplied (local decision)' : 'Do not stock'}{!item.active && ' · superseded by current Xero evidence'}</p>}
        {item.purchasingRetiredReason && <p className="mt-1 text-xs text-amber-900">{item.purchasingRetiredReason}</p>}
        {item.creationPending && <p className="mt-1 text-xs text-sky-800">Created in Xero · awaiting stock import</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {item.supplier === 'victron' && !item.decision && !item.purchasingRetiredReason && !item.creationPending && item.xeroStatus === 'missing' && <button type="button" onClick={() => open(item)} className="rounded-md border border-sky-300 px-3 py-2 text-sm font-semibold text-sky-900">Create in Xero</button>}
        <button type="button" onClick={() => open(item)} className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-semibold">Review</button>
      </div>
    </li>)}</ul>
    {!filtered.length && <p className="mt-3 text-sm text-zinc-500">No items match this view.</p>}
    {filtered.length > limit && <button type="button" onClick={() => setLimit(value => value + 25)} className="mt-3 text-sm font-semibold text-sky-800 underline">Show more ({filtered.length - limit} remaining)</button>}
    <dialog ref={dialog} onCancel={event => { if (busy) event.preventDefault(); }} onClick={event => { if (!busy && event.target === event.currentTarget) dialog.current?.close(); }} className="fixed inset-0 m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-xl border border-zinc-300 bg-white p-5 text-sm text-zinc-900 shadow-xl backdrop:bg-black/30">
      {selected && <>
        <div className="flex items-start justify-between gap-3"><h3 className="font-bold">Review {selected.sku}</h3><button type="button" disabled={busy} onClick={() => dialog.current?.close()} className="font-semibold text-sky-800">Close</button></div>
        <p className="mt-2">{selected.name}</p>
        {selected.familySkus.length > 1 && <p className="mt-2 rounded-md bg-violet-50 p-3 text-violet-900">Stock family: {selected.familySkus.join(', ')}. This decision does not alter the succession map or other family members.</p>}
        <section className="mt-4 border-t border-zinc-200 pt-4">
          <h4 className="font-semibold">Create in Xero</h4>
          <p className="mt-2 text-zinc-600">Creates a tracked product definition only, using the normal E-Order cost and selling price = cost ÷ 0.525, excluding VAT. Uses Victron accounts: inventory 631, cost of sales 311, sales 201. No opening balance, stock adjustment or receipt is sent.</p>
          {selected.purchasingRetiredReason && <p className="mt-2 text-amber-900">{selected.purchasingRetiredReason} Creation is unavailable for this retired SKU.</p>}
          {selected.purchasingRetiredReason && <button type="button" disabled={busy} onClick={() => void act(selected.purchasingRestored ? 'archive_purchasing' : 'restore_purchasing')} className="mt-2 font-semibold text-sky-800 underline">{selected.purchasingRestored ? 'Archive from purchasing again' : 'Restore to purchasing review'}</button>}
          {selected.supplier === 'victron' && !selected.purchasingRetiredReason && !selected.creationPending && !selected.decision && <button type="button" disabled={busy} onClick={() => void create('preview')} className="mt-3 rounded-md border border-zinc-300 px-3 py-2 font-semibold disabled:opacity-50">Preview creation</button>}
          {preview && <div className="mt-3 rounded-md bg-sky-50 p-3">
            <p>Cost: <strong>R{preview.cost.toFixed(2)}</strong> · Selling: <strong>R{preview.selling.toFixed(2)}</strong> · excluding VAT</p>
            <button type="button" disabled={busy} onClick={() => void create('create')} className="mt-3 rounded-md bg-zinc-900 px-3 py-2 font-semibold text-white disabled:opacity-50">{busy ? 'Working…' : 'Confirm — Create in Xero'}</button>
          </div>}
          <p className="mt-2 text-xs text-zinc-500">Check reads the latest saved Xero item list. A newly created item may need time to appear. Last observed: {selected.observedAt ? new Date(selected.observedAt).toLocaleString('en-ZA') : 'not recorded'}.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3"><a href="https://go.xero.com/" target="_blank" rel="noreferrer" className="font-semibold text-sky-800 underline">Open Xero</a><button type="button" disabled={busy} onClick={() => void act('check')} className="rounded-md border border-zinc-300 px-3 py-2 font-semibold disabled:opacity-50">{busy ? 'Working…' : 'Check Xero item'}</button></div>
        </section>
        {selected.xeroStatus === 'missing' && <section className="mt-4 border-t border-zinc-200 pt-4">
          <h4 className="font-semibold">Acknowledge the missing-item alert</h4>
          <label className="mt-3 flex gap-2"><input type="radio" name="stock-decision" checked={decision === 'do_not_stock'} onChange={() => setDecision('do_not_stock')} />Do not stock</label>
          {selected.supplier === 'victron' && <label className="mt-2 flex gap-2"><input type="radio" name="stock-decision" checked={decision === 'retired'} onChange={() => setDecision('retired')} />No longer supplied by Victron</label>}
          <p className="mt-2 text-xs text-zinc-600">This silences the missing-Xero alert. It does not confirm zero stock, delete catalogue or sales history, or change purchasing quantities. A later Xero item observation takes precedence.</p>
          {decision === 'retired' && <p className="mt-2 text-xs text-amber-900">Missing from Xero does not prove supplier retirement. Confirm with Victron and record the reason. If replaced, review the successor under Details in Replenishment.</p>}
          <label className="mt-3 block font-medium" htmlFor="stock-review-note">{decision === 'retired' ? 'Reason / supplier evidence (required)' : 'Note (optional)'}</label>
          <textarea id="stock-review-note" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} className="mt-1 min-h-20 w-full rounded-md border border-zinc-300 p-2" />
          <button type="button" disabled={busy || (decision === 'retired' && !note.trim())} onClick={() => void act(decision)} className="mt-2 rounded-md bg-zinc-900 px-3 py-2 font-semibold text-white disabled:opacity-50">Save decision</button>
        </section>}
        {selected.decision && <button type="button" disabled={busy} onClick={() => void act('undo')} className="mt-4 font-semibold text-sky-800 underline">Undo saved decision</button>}
        {error && <p role="alert" className="mt-3 text-red-800">{error}</p>}
      </>}
    </dialog>
  </section>;
}
