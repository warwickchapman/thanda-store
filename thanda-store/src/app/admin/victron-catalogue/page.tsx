'use client';
import { useEffect, useRef, useState } from 'react';
import { AdminMenu } from '@/components/admin/admin-menu';
import { linkedCatalogueItem } from '@/lib/victron-catalogue-navigation.mjs';
import { archiveReadiness, archiveReadyRows } from '@/lib/victron-archive-review.mjs';
type Row = { fingerprint: string; company: string; sku: string; name: string; kind: string; reason?: string | null; previous?: number | null; proposed?: number | null; list?: number | null; listSource?: string; stock?: number | null; stockTracked?: boolean | null; itemId?: string | null; zaStock?: number | null; reviewAction?: 'new' | 'price' | 'keep' | null; approvalReason?: string | null; reviewBlocker?: string | null; ignoredUntil?: string | null; replaces: string[]; replacedBy: string[]; eligibleForArchiveReview?: boolean };
type AuditEvent = { created_at: string; actor: string; action: string; company?: string; sku?: string; details: { note?: string; changes?: { sku: string; previous?: number; proposed?: number }[]; result?: { error?: string } } };
type Counts = { price: number; selling: number; new: number; review: number; archive: number; total: number };
type State = { overdue: boolean; attention: boolean; counts: Record<string, Counts>; rows: Row[]; error?: string; checked_at?: string; observed_at?: string; signature: string; acknowledged_signature?: string; events: AuditEvent[] };
const money = (n?: number | null) => n == null ? 'Unknown' : `R ${Number(n).toFixed(2)}`;
const hasZaStock = (row: Row) => row.zaStock != null && row.zaStock > 0;
const needsReview = (row: Row) => hasZaStock(row) && !row.ignoredUntil;
const archiveLabels = { ready: 'Ready to archive in Xero', waiting: 'Waiting for supplier evidence', stock: 'Non-zero stock', unknown: 'Stock or item needs checking', stale: 'Refresh saved comparison' };
const changeTypes = [['price','Cost changes'],['selling','Selling prices'],['new','New products'],['review','Needs review'],['archive','Archive candidates']] as const;
const reviewDate = (value: string) => new Date(value).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' });
const unknownOutcome = 'The result could not be confirmed. Do not repeat this action until the saved attempt has been reconciled with Xero.';
async function readResponse(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(fallback);
  return payload;
}
export default function VictronCatalogue() {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const [activeUpdate, setActiveUpdate] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('price');
  const [archiveFilter, setArchiveFilter] = useState('all');
  const [company, setCompany] = useState('thanda-solar');
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [proposal, setProposal] = useState<Row | null>(null);
  const confirmationRef = useRef<HTMLElement | null>(null);
  const [linkedItem, setLinkedItem] = useState<{ company: string; sku: string } | null>(null);
  const followLinkedCategory = useRef(false);
  function resetSelection() {
    setLimit(50); setSelected([]); setConfirmBatch(false); setProposal(null);
    setActiveUpdate(null); setError(''); setMessage('');
  }
  async function load() {
    const response = await fetch('/api/admin/victron-catalogue', { cache: 'no-store' });
    const payload = await readResponse(response, 'The comparison could not be loaded. Please try again.');
    if (!response.ok) throw new Error(payload.error || 'The comparison could not be loaded.');
    setData(payload);
    if (followLinkedCategory.current && linkedItem?.company === company && linkedItem.sku === query) {
      const linkedRows = payload.rows.filter((row: Row) => row.company === company && row.sku === linkedItem.sku);
      setKind(linkedRows.find((row: Row) => row.kind === kind)?.kind || linkedRows[0]?.kind || 'review');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/admin/victron-catalogue', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const payload = await readResponse(response, 'The comparison could not be loaded. Please try again.');
      if (!response.ok) throw new Error(payload.error || 'The comparison could not be loaded.');
      setData(payload);
      const linked = linkedCatalogueItem(window.location.search, payload.rows);
      if (linked) {
        followLinkedCategory.current = Boolean(linked.sku);
        setCompany(linked.company); setQuery(linked.sku); setKind(linked.kind);
        setLinkedItem(linked.sku ? { company: linked.company, sku: linked.sku } : null);
      }
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (proposal) confirmationRef.current?.scrollIntoView({ block: 'nearest' });
  }, [proposal]);
  async function action(body: Record<string, unknown>) {
    if (actionPending.current) return;
    actionPending.current = true;
    setActiveUpdate((body.action === 'apply' || body.action === 'apply-selling' || body.action === 'resolve-review') && typeof body.fingerprint === 'string' ? body.fingerprint : null);
    setBusy(true); setError(''); setMessage('');
    const writesXero = body.action === 'apply' || body.action === 'apply-selling' || body.action === 'apply-selling-batch' || body.action === 'apply-batch' || body.action === 'apply-create-batch'
      || (body.action === 'resolve-review' && data?.rows.find(row => row.fingerprint === body.fingerprint)?.reviewAction !== 'keep');
    try {
      const response = await fetch('/api/admin/victron-catalogue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .catch(() => { throw new Error(writesXero ? unknownOutcome : 'The action could not be completed. Please try again.'); });
      const payload = await readResponse(response, writesXero ? unknownOutcome : 'The action could not be completed. Please try again.');
      if (!response.ok) {
        if (payload.code === 'UNKNOWN_OUTCOME') {
          setSelected([]); setConfirmBatch(false); setProposal(null);
          await load().catch(() => {});
        }
        if (payload.code === 'STALE_SELECTION' || payload.code === 'INVALID_SELECTION') {
          setSelected([]); setConfirmBatch(false); setProposal(null);
          try { await load(); }
          catch { throw new Error(`${payload.error} The comparison could not be refreshed; click Compare saved records before trying again.`); }
        }
        throw new Error(payload.error || (writesXero ? unknownOutcome : 'The action could not be completed.'));
      }
      setMessage(payload.message); setProposal(null); setSelected([]); setConfirmBatch(false);
      await load().catch(() => { setError('The action completed, but the comparison could not be loaded. Compare saved records before making further changes.'); });
      window.dispatchEvent(new Event('victron-catalogue-changed'));
    } catch (e) {
      if (writesXero) { setSelected([]); setConfirmBatch(false); setProposal(null); }
      setError(e instanceof Error ? e.message : 'Unable to complete action');
    }
    finally { actionPending.current = false; setBusy(false); }
  }
  const stale = data?.overdue ?? true;
  const companyRows = (data?.rows || []).filter(r => r.company === company);
  const counts = data?.counts?.[company];
  const archiveContext = { overdue: stale, error: data?.error || null };
  const archiveState = (row: Row) => archiveReadiness(row, archiveContext);
  const readyArchives = archiveReadyRows(companyRows, archiveContext);
  const focusedSku = linkedItem?.company === company && linkedItem.sku === query ? linkedItem.sku : null;
  const linkedRow = focusedSku ? companyRows.find(row => row.sku === focusedSku && row.kind === kind) || companyRows.find(row => row.sku === focusedSku) : null;
  const rows = companyRows.filter(r => r.kind === kind && (kind !== 'archive' || archiveFilter === 'all' || archiveState(r).status === archiveFilter)
    && (focusedSku ? r.sku === focusedSku : `${r.sku} ${r.name}`.toLowerCase().includes(query.toLowerCase())));
  const isNew = kind === 'new';
  const isReview = kind === 'review';
  const isArchive = kind === 'archive';
  const isSelling = kind === 'selling';
  const supportsBatch = kind === 'price' || isNew || isSelling;
  const selectableRows = rows.filter(r => !r.reason && !r.reviewBlocker);
  const selectedRows = rows.filter(r => selected.includes(r.fingerprint));
  const button = 'rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50';
  return <main className="min-h-screen bg-zinc-50 p-4 text-zinc-950"><div className="mx-auto max-w-6xl space-y-5">
    <header className="flex justify-between gap-3"><h1 className="text-2xl font-bold">Victron catalogue review</h1><AdminMenu /></header>
    <p className="text-sm">Purchase costs: Thanda uses E-Order cost; Sensible uses E-Order ZAR list less 40%. Proposed selling prices use catalogue list. All prices exclude VAT.</p>
    <p className="text-sm text-zinc-600">Daily checks compare saved costs and selling prices. Choose each update to apply it to Xero. New items start at list selling price with no stock balance.</p>
    <div className="flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => action({ action: 'refresh' })}>Compare saved records</button></div>
    <p className="text-xs">Last check: {data?.checked_at ? new Date(data.checked_at).toLocaleString('en-ZA') : 'Not yet run'}. Supplier observation: {data?.observed_at ? new Date(data.observed_at).toLocaleString('en-ZA') : 'Unavailable'}.</p>
    {(error || data?.error || stale) && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3">{error || data?.error || 'Daily check is overdue or has not run. Apply actions require fresh evidence.'}</p>}
    {message && <p role="status" className="rounded bg-green-50 p-3">{message}</p>}
    <div className="flex flex-wrap gap-3">
      <select aria-label="Company" className={button} disabled={busy} value={company} onChange={e => { followLinkedCategory.current = false; setCompany(e.target.value); setArchiveFilter('all'); resetSelection(); }}><option value="thanda-solar">Thanda ({data?.counts?.['thanda-solar']?.total ?? '…'})</option><option value="sensible-solar">Sensible ({data?.counts?.['sensible-solar']?.total ?? '…'})</option></select>
      <select aria-label="Change type" className={button} disabled={busy} value={kind} onChange={e => { followLinkedCategory.current = false; setKind(e.target.value); setArchiveFilter('all'); resetSelection(); }}>{changeTypes.map(([key,label]) => <option key={key} value={key}>{label} ({counts?.[key] ?? '…'})</option>)}</select>
      {isArchive && <select aria-label="Archive status" className={button} disabled={busy} value={archiveFilter} onChange={e => { followLinkedCategory.current = false; setArchiveFilter(e.target.value); resetSelection(); }}>{[['all','All pending checks'],...Object.entries(archiveLabels)].map(([key,label]) => <option key={key} value={key}>{label} ({companyRows.filter(r => r.kind === 'archive' && (key === 'all' || archiveState(r).status === key)).length})</option>)}</select>}
      <input aria-label="Find product" disabled={busy} className="rounded border px-3 py-2" placeholder="Find SKU or description" value={query} onChange={e => { followLinkedCategory.current = false; setQuery(e.target.value); resetSelection(); }} />
    </div>
    {!isArchive && (counts?.archive ?? 0) > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-zinc-200 bg-white p-3 text-sm">
      <p>Archive candidates are separate from the company total above.</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={() => { followLinkedCategory.current = false; setKind('archive'); setQuery(''); setLinkedItem(null); setArchiveFilter('all'); resetSelection(); }}>Review archive candidates ({counts?.archive})</button>
        <button className={button} disabled={busy} onClick={() => { followLinkedCategory.current = false; setKind('archive'); setQuery(''); setLinkedItem(null); setArchiveFilter('ready'); resetSelection(); }}>Retired items with zero stock ({readyArchives.length})</button>
      </div>
    </div>}
    {linkedItem && company === linkedItem.company && query === linkedItem.sku && <p role="status" className="rounded border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
      Opened from the missing-item link for <b>{linkedItem.sku}</b>. {linkedRow
        ? `Its saved proposal is in ${changeTypes.find(([key]) => key === linkedRow.kind)?.[1] || linkedRow.kind}. A silenced or ignored item remains visible but is not counted for review.`
        : 'There is no pending proposal for this exact SKU in the saved comparison. Use Compare saved records to check the latest imported evidence. This does not confirm that the item is present in Xero.'}
    </p>}
    {supportsBatch && <div className="flex flex-wrap gap-3"><button className={button} disabled={busy || stale || Boolean(data?.error) || !selectableRows.length} onClick={() => { setSelected(selectableRows.slice(0,50).map(r => r.fingerprint)); setConfirmBatch(false); }}>Select first {Math.min(50,selectableRows.length)} matching {isNew ? 'products' : isSelling ? 'selling prices' : 'changes'}</button><button className={button} disabled={busy || !selected.length || stale || Boolean(data?.error)} onClick={() => { setConfirmBatch(true); setProposal(null); }}>Review {selected.length} selected {isNew ? 'additions' : isSelling ? 'selling prices' : 'updates'}</button><button className={button} disabled={busy} onClick={() => { setSelected([]); setConfirmBatch(false); }}>Clear selection</button></div>}
    {confirmBatch && <section aria-label={isNew ? 'Confirm product additions' : isSelling ? 'Confirm selling price batch' : 'Confirm cost batch'} className="rounded border-2 border-sky-700 bg-white p-4"><h2 className="font-bold">Confirm {selected.length} {isNew ? 'product additions' : isSelling ? 'selling price updates' : 'cost updates'} for {company === 'thanda-solar' ? 'Thanda' : 'Sensible'}</h2><p className="my-3 text-sm">{isNew ? 'Add the selected products shown below at their displayed purchase costs and initial list selling prices, with no opening stock balance. Existing product codes are checked again before creating.' : isSelling ? 'Update the selected Xero selling prices to the catalogue list prices shown below. All prices exclude VAT. Prices are checked again before writing.' : 'Only the selected purchase costs shown below will change. Prices are checked again before writing.'} An uncertain result stops retries until reconciled.</p>
      {isSelling && <><p className="mb-2 text-xs text-zinc-600 sm:hidden">Scroll the table sideways to see all columns.</p><div className="mb-4 overflow-x-auto"><table aria-label="Selected selling price updates" className="w-full min-w-[640px] text-left text-sm"><thead><tr className="border-b"><th className="p-2">Product</th><th className="p-2">Current Xero selling price</th><th className="p-2">Catalogue list price</th><th className="p-2">Difference</th></tr></thead><tbody>{selectedRows.map(r => <tr key={r.fingerprint} className="border-b"><td className="p-2"><b>{r.sku}</b><p>{r.name}</p></td><td className="p-2 whitespace-nowrap">{money(r.previous)}</td><td className="p-2 whitespace-nowrap">{money(r.proposed)}</td><td className="p-2 whitespace-nowrap">{r.previous != null && r.proposed != null ? money(r.proposed-r.previous) : 'Unknown'}</td></tr>)}</tbody></table></div></>}
      <button className={button} disabled={busy || !selected.length || selectedRows.length !== selected.length || stale || Boolean(data?.error)} onClick={() => action({ action: isNew ? 'apply-create-batch' : isSelling ? 'apply-selling-batch' : 'apply-batch', fingerprints: selected, ...(isSelling ? { confirmed: true } : {}) })}>{busy ? (isNew ? 'Adding…' : 'Working…') : (isNew ? 'Add selected products to Xero' : isSelling ? 'Confirm selected selling price updates' : 'Confirm selected cost updates')}</button></section>}
    {isNew && <p className="text-sm text-zinc-600">Add to Xero creates the product at the purchase cost and initial list selling price shown below, with no opening stock balance.</p>}
    {isSelling && <p className="rounded border border-sky-200 bg-sky-50 p-3 text-sm">Compare saved Xero selling prices with current catalogue list prices. Review an individual difference or select up to 50 selling prices for the selected Xero company.</p>}
    {isReview && <p className="text-sm text-zinc-600">Only products with confirmed ZA stock and no active ignore are counted and shown first. Others stay visible. Each daily or manual comparison checks saved stock and returns stocked products to review when their 90-day ignore expires. You can undo an ignore sooner.</p>}
    {isArchive && <>
      <p className="rounded bg-amber-50 p-3 text-sm"><b>{readyArchives.length} retired {readyArchives.length === 1 ? 'item has' : 'items have'} confirmed zero tracked stock in {company === 'thanda-solar' ? 'Thanda' : 'Sensible'}.</b> Ready items require fresh saved supplier and Xero evidence. Check current stock and open orders before archiving in Xero. Archive there first, then record completion here. This page does not archive items or check orders.</p>
      <p className="text-sm text-zinc-600">Counts cover all archive checks for {company === 'thanda-solar' ? 'Thanda' : 'Sensible'}, before your search. Waiting items need complete supplier observations on two different dates; comparing the same saved observation again does not advance them.</p>
      <details className="rounded border bg-white p-4"><summary className="cursor-pointer font-semibold">What to check before archiving</summary><ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
        <li>Use the same company in Xero. Confirm physical stock and Xero stock agree. Unknown stock is not zero; resolve quantity or value differences first.</li>
        <li>Check open purchase orders, supplier backorders, deliveries still coming, accepted quotes and unfinished bills or invoices. Check repeating transactions that still use this item.</li>
        <li>Where a replacement is shown, confirm the correct replacement is in Xero for future orders. Keep the original SKU on historical transactions.</li>
        <li>Complete the archive in Xero, then use Record completed archive. This button saves your confirmation; it does not verify the archive in Xero.</li>
      </ul></details>
    </>}
    {(isSelling || isArchive) && <p className="text-xs text-zinc-600 sm:hidden">Scroll the table sideways to see all columns.</p>}
    <div className="overflow-x-auto rounded border bg-white"><table className={`w-full text-left text-sm ${isSelling ? 'min-w-[900px]' : isArchive ? 'min-w-[760px]' : ''}`}>
      <thead><tr className="border-b">
        <th className="p-3">Product</th>
        {isReview ? <><th className="p-3 whitespace-nowrap">ZA stock</th><th className="p-3">Review status</th></>
          : isArchive ? <><th className="p-3 whitespace-nowrap">Company stock</th><th className="p-3">Archive status</th></>
          : isNew ? <><th className="p-3">Purchase cost</th><th className="p-3">Initial selling price</th></>
            : isSelling ? <><th className="p-3">Current Xero selling price</th><th className="p-3">Catalogue list price</th><th className="p-3">Difference</th></>
            : <><th className="p-3">Current cost</th><th className="p-3">Proposed cost</th><th className="p-3">Change</th></>}
        <th className="p-3">{isReview || isArchive ? 'Reason and action' : 'Action / reason'}</th>
      </tr></thead>
      <tbody>{rows.slice(0,limit).map(r => <tr key={r.fingerprint} className="border-b align-top">
        <td className="p-3">
          {supportsBatch && !r.reason && !r.reviewBlocker && <input type="checkbox" aria-label={`Select ${r.sku}`} className="mr-2" checked={selected.includes(r.fingerprint)} disabled={busy || stale || Boolean(data?.error) || (!selected.includes(r.fingerprint) && selected.length >= 50)} onChange={e => { setSelected(e.target.checked ? [...selected,r.fingerprint] : selected.filter(f => f !== r.fingerprint)); setConfirmBatch(false); }} />}
          <b>{r.sku}</b><p>{r.name}</p>
          {r.listSource === 'calculated' && <p className="text-xs text-zinc-600">List calculated: E-Order cost ÷ 0.525</p>}
          {r.replaces.length > 0 && <p className="text-xs">Replaces {r.replaces.join(', ')}</p>}
          {r.replacedBy.length > 0 && <p className="text-xs">Replaced by {r.replacedBy.join(', ')}</p>}
        </td>
        {isReview ? <>
          <td className="p-3 whitespace-nowrap">{r.zaStock ?? 'Unknown'}</td>
          <td className="p-3">
            <span className={`inline-block rounded px-2 py-1 text-xs font-semibold ${needsReview(r) ? 'bg-amber-50 text-amber-900' : 'bg-zinc-100 text-zinc-600'}`}>{r.ignoredUntil ? `Ignored until ${reviewDate(r.ignoredUntil)}` : needsReview(r) ? 'Review candidate' : 'Silenced'}</span>
            <p className="mt-1 text-xs text-zinc-600">{r.ignoredUntil ? 'Not counted' : needsReview(r) ? 'ZA stock available · Counted' : r.zaStock == null ? 'ZA stock unknown · Not counted' : 'No ZA stock · Not counted'}</p>
          </td>
        </> : isArchive ? <>
          <td className="p-3 whitespace-nowrap">{r.stock ?? 'Unknown'}<p className="text-xs text-zinc-600">{r.stockTracked === true ? 'Tracked in Xero' : r.stockTracked === false ? 'Untracked in Xero' : 'Tracking unknown'}</p></td>
          <td className="p-3"><span className={`inline-block rounded px-2 py-1 text-xs font-semibold ${archiveState(r).ready ? 'bg-amber-50 text-amber-900' : 'bg-zinc-100 text-zinc-600'}`}>{archiveState(r).label}</span></td>
        </> : isNew ? <>
          <td className="p-3 whitespace-nowrap">{money(r.proposed)}</td><td className="p-3 whitespace-nowrap">{money(r.list)}</td>
        </> : <>
          <td className="p-3 whitespace-nowrap">{money(r.previous)}</td><td className="p-3 whitespace-nowrap">{money(r.proposed)}</td>
          <td className="p-3">{r.previous != null && r.proposed != null ? `${money(r.proposed-r.previous)}${r.previous > 0 ? ` (${((r.proposed/r.previous-1)*100).toFixed(1)}%)` : ''}` : '—'}</td>
        </>}
        <td className="p-3 max-w-sm">
          {isReview ? <div className="space-y-2">
            <p>{r.reason}</p>
            {r.reviewBlocker && r.reviewBlocker !== r.reason && <p className="text-sm text-amber-800">{r.reviewBlocker}</p>}
            {r.approvalReason && r.approvalReason !== r.reason && r.approvalReason !== r.reviewBlocker && <p className="text-xs text-zinc-600">{r.approvalReason}</p>}
            {needsReview(r) && r.reviewAction && <>
              {r.reviewAction === 'new' ? <p className="text-sm">Purchase cost: {money(r.proposed)}<br />Initial selling price: {money(r.list)}<br />No opening stock balance.</p>
                : r.reviewAction === 'price' ? <p className="text-sm">Purchase cost: {money(r.previous)} → {money(r.proposed)}</p>
                  : <p className="text-sm">Already in Xero. Purchase cost: {money(r.previous)}.</p>}
            </>}
            <div className="flex flex-wrap gap-2">
              {needsReview(r) && r.reviewAction && <button className={button} disabled={busy || stale || Boolean(data?.error)} onClick={() => action({ action: 'resolve-review', fingerprint: r.fingerprint })}>{busy && activeUpdate === r.fingerprint ? (r.reviewAction === 'new' ? 'Adding…' : r.reviewAction === 'price' ? 'Updating…' : 'Saving…') : r.reviewAction === 'new' ? 'Add to Xero' : r.reviewAction === 'price' ? 'Update' : 'Keep in Xero'}</button>}
              {needsReview(r) && <button className={button} disabled={busy || stale || Boolean(data?.error)} onClick={() => action({ action: 'ignore-review', fingerprint: r.fingerprint })}>Ignore for 90 days</button>}
              {r.ignoredUntil && <button className={button} disabled={busy || stale || Boolean(data?.error)} onClick={() => action({ action: 'unignore-review', fingerprint: r.fingerprint })}>Undo ignore</button>}
            </div>
          </div> : isSelling ? <div className="space-y-2">
            {(r.reason || r.reviewBlocker) && <p>{r.reason || r.reviewBlocker}</p>}
            <button className={button} disabled={busy || stale || Boolean(data?.error) || Boolean(r.reason || r.reviewBlocker)} onClick={() => { setProposal(r); setConfirmBatch(false); }}>Review selling price</button>
          </div> : r.reason || (supportsBatch && <button className={button} disabled={busy || stale || Boolean(data?.error)} onClick={() => action({ action: 'apply', fingerprint: r.fingerprint, confirmed: true })}>{busy && activeUpdate === r.fingerprint ? (isNew ? 'Adding…' : 'Updating…') : (isNew ? 'Add to Xero' : 'Update')}</button>)}
          {activeUpdate === r.fingerprint && (error || message) && <p role={error ? 'alert' : 'status'} className={`mt-2 text-sm ${error ? 'text-amber-800' : 'text-green-800'}`}>{error || message}</p>}
          {r.kind === 'archive' && <div className="mt-2 space-y-2">{archiveState(r).blocker && <p className="text-xs text-zinc-600">{archiveState(r).blocker}</p>}<button className={button} disabled={busy || !archiveState(r).ready} onClick={() => setProposal(r)}>Record completed archive</button></div>}
        </td>
      </tr>)}</tbody>
    </table>{!rows.length && <p className="p-4">No matching proposals in the saved comparison.</p>}</div>
    {rows.length > limit && <button className={button} onClick={() => setLimit(limit+50)}>Show more</button>}
    {proposal?.kind === 'selling' ? <section ref={confirmationRef} className="rounded border-2 border-sky-700 bg-white p-4" aria-label="Confirm selling price update"><h2 className="font-bold">{proposal.company === 'thanda-solar' ? 'Thanda' : 'Sensible'} · {proposal.sku}</h2><p className="mt-2">{proposal.name}</p><dl className="my-3 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-zinc-600">Current Xero selling price</dt><dd className="font-semibold">{money(proposal.previous)}</dd></div><div><dt className="text-zinc-600">Catalogue list price</dt><dd className="font-semibold">{money(proposal.proposed)}</dd></div></dl><p className="mb-3 text-sm">Update this item&apos;s selling price in the selected Xero company. All prices exclude VAT.</p><div className="flex flex-wrap gap-3"><button className={button} disabled={busy || stale || Boolean(data?.error) || Boolean(proposal.reason || proposal.reviewBlocker)} onClick={() => action({ action: 'apply-selling', fingerprint: proposal.fingerprint, confirmed: true })}>{busy ? 'Updating…' : 'Update Xero selling price'}</button><button className={button} disabled={busy} onClick={() => setProposal(null)}>Cancel</button></div></section>
      : proposal && <section ref={confirmationRef} className="rounded border-2 border-sky-700 bg-white p-4" aria-label="Confirm completed archive"><h2 className="font-bold">{proposal.company === 'thanda-solar' ? 'Thanda' : 'Sensible'} · {proposal.sku}</h2><p className="my-3">Confirm you checked outstanding orders, stock is zero, and you have completed archival in Xero.</p><div className="flex gap-3"><button className={button} disabled={busy || !archiveState(proposal).ready} onClick={() => action({ action: 'archive-reviewed', fingerprint: proposal.fingerprint, confirmed: true })}>{busy ? 'Working…' : 'Confirm'}</button><button className={button} disabled={busy} onClick={() => setProposal(null)}>Cancel</button></div></section>}
    <details className="rounded border bg-white p-4"><summary className="cursor-pointer font-semibold">Quarterly sanity check</summary><p className="my-3 text-sm">Check the official quarterly price list against E-Order, announced new products, phase-outs and article-number changes. Record discrepancies here; the quarterly list never overwrites E-Order prices. Q4 2026 highlights: Venus GX end of life; gradual Lithium Smart phase-out; new article numbers; November EV charger launches.</p><textarea aria-label="Quarterly check findings" className="w-full rounded border p-3" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Quarter, source/reference, checks performed and discrepancies…" /><button className={button} disabled={busy || note.trim().length < 10} onClick={() => action({ action: 'quarterly', note })}>Save check record</button></details>
    <details className="rounded border bg-white p-4"><summary className="cursor-pointer font-semibold">Recent audit history</summary><ul className="mt-3 space-y-2 text-sm">{data?.events.map((e,i) => <li key={i}>{new Date(e.created_at).toLocaleString('en-ZA')} · {e.action} · {e.company} {e.sku} · operator {e.actor}{e.details.note && <p>{e.details.note}</p>}{e.details.result?.error && <p className="text-amber-800">{e.details.result.error}</p>}{e.details.changes && <details><summary className="cursor-pointer">View {e.details.changes.length} saved changes</summary><ul>{e.details.changes.map(c => <li key={c.sku}>{c.sku}: {money(c.previous)} → {money(c.proposed)}</li>)}</ul></details>}</li>)}</ul></details>
  </div></main>;
}
