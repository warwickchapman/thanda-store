'use client';
import { useEffect, useState } from 'react';
import { AdminMenu } from '@/components/admin/admin-menu';
type Row = { fingerprint: string; company: string; sku: string; name: string; kind: string; reason?: string; previous?: number; proposed?: number; list?: number; listSource?: string; stock?: number; replaces: string[]; replacedBy: string[]; eligibleForArchiveReview?: boolean };
type AuditEvent = { created_at: string; actor: string; action: string; company?: string; sku?: string; details: { note?: string; changes?: { sku: string; previous?: number; proposed?: number }[]; result?: { error?: string } } };
type State = { overdue: boolean; rows: Row[]; error?: string; checked_at?: string; observed_at?: string; signature: string; acknowledged_signature?: string; events: AuditEvent[] };
const money = (n?: number) => n == null ? 'Unknown' : `R ${Number(n).toFixed(2)}`;
export default function VictronCatalogue() {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('price');
  const [company, setCompany] = useState('thanda-solar');
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [proposal, setProposal] = useState<Row | null>(null);
  async function load() {
    const response = await fetch('/api/admin/victron-catalogue', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    setData(payload);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/admin/victron-catalogue', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setData(payload);
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, []);
  async function action(body: Record<string, unknown>) {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/admin/victron-catalogue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setMessage(payload.message); setProposal(null); setSelected([]); setConfirmBatch(false); await load(); window.dispatchEvent(new Event('victron-catalogue-changed'));
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to complete action'); }
    finally { setBusy(false); }
  }
  const stale = data?.overdue ?? true;
  const rows = (data?.rows || []).filter(r => r.company === company && r.kind === kind && `${r.sku} ${r.name}`.toLowerCase().includes(query.toLowerCase()));
  const button = 'rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50';
  return <main className="min-h-screen bg-zinc-50 p-4 text-zinc-950"><div className="mx-auto max-w-6xl space-y-5">
    <header className="flex justify-between gap-3"><div><h1 className="text-2xl font-bold">Victron catalogue review</h1><p className="mt-2 text-sm">Thanda: E-Order cost. Sensible: E-Order ZAR list less 40%. All prices exclude VAT.</p></div><AdminMenu /></header>
    <p className="text-sm text-zinc-600">Daily checks use saved records. Existing selling prices and stock balances stay unchanged. New items start at list selling price with no stock balance.</p>
    <div className="flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => action({ action: 'refresh' })}>Compare saved records</button>
      {data?.signature && data.signature !== data.acknowledged_signature && <button className={button} disabled={busy} onClick={() => action({ action: 'acknowledge', signature: data.signature })}>Acknowledge change alert</button>}</div>
    <p className="text-xs">Last check: {data?.checked_at ? new Date(data.checked_at).toLocaleString('en-ZA') : 'Not yet run'}. Supplier observation: {data?.observed_at ? new Date(data.observed_at).toLocaleString('en-ZA') : 'Unavailable'}.</p>
    {(error || data?.error || stale) && <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3">{error || data?.error || 'Daily check is overdue or has not run. Apply actions require fresh evidence.'}</p>}
    {message && <p role="status" className="rounded bg-green-50 p-3">{message}</p>}
    <div className="flex flex-wrap gap-3">
      <select aria-label="Company" className={button} value={company} onChange={e => { setCompany(e.target.value); setLimit(50); setSelected([]); setConfirmBatch(false); }}><option value="thanda-solar">Thanda</option><option value="sensible-solar">Sensible</option></select>
      <select aria-label="Change type" className={button} value={kind} onChange={e => { setKind(e.target.value); setLimit(50); setSelected([]); setConfirmBatch(false); }}>{[['price','Cost changes'],['new','New products'],['archive','Archive checklist'],['review','Needs review / excluded']].map(([key,label]) => <option key={key} value={key}>{label} ({data?.rows.filter(r => r.company === company && r.kind === key).length || 0})</option>)}</select>
      <input aria-label="Find product" className="rounded border px-3 py-2" placeholder="Find SKU or description" value={query} onChange={e => { setQuery(e.target.value); setLimit(50); setSelected([]); setConfirmBatch(false); }} />
    </div>
    {kind === 'price' && <div className="flex flex-wrap gap-3"><button className={button} disabled={busy || stale || Boolean(data?.error)} onClick={() => { setSelected(rows.slice(0,50).map(r => r.fingerprint)); setConfirmBatch(false); }}>Select first {Math.min(50,rows.length)} matching changes</button><button className={button} disabled={busy || !selected.length || stale || Boolean(data?.error)} onClick={() => { setConfirmBatch(true); setProposal(null); }}>Review {selected.length} selected updates</button><button className={button} onClick={() => { setSelected([]); setConfirmBatch(false); }}>Clear selection</button></div>}
    {confirmBatch && <section aria-label="Confirm cost batch" className="rounded border-2 border-sky-700 bg-white p-4"><h2 className="font-bold">Confirm {selected.length} cost updates for {company === 'thanda-solar' ? 'Thanda' : 'Sensible'}</h2><p className="my-3 text-sm">Only the selected purchase costs shown below will change. Prices are checked again before writing. An uncertain result stops retries until reconciled.</p><button className={button} disabled={busy || stale || Boolean(data?.error)} onClick={() => action({ action: 'apply-batch', fingerprints: selected })}>{busy ? 'Working…' : 'Confirm selected cost updates'}</button></section>}
    {kind === 'archive' && <p className="rounded bg-amber-50 p-3 text-sm">Archive in Xero only after checking stock and outstanding orders. This page records your completion; it cannot archive through the Xero API.</p>}
    <div className="overflow-x-auto rounded border bg-white"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-3">Product</th><th>Current cost</th><th>Proposed cost</th><th>Change</th><th className="p-3">Action / reason</th></tr></thead><tbody>
      {rows.slice(0,limit).map(r => <tr key={r.fingerprint} className="border-b align-top"><td className="p-3">{r.kind === 'price' && <input type="checkbox" aria-label={`Select ${r.sku}`} className="mr-2" checked={selected.includes(r.fingerprint)} disabled={busy || (!selected.includes(r.fingerprint) && selected.length >= 50)} onChange={e => { setSelected(e.target.checked ? [...selected,r.fingerprint] : selected.filter(f => f !== r.fingerprint)); setConfirmBatch(false); }} />}<b>{r.sku}</b><p>{r.name}</p>{r.listSource === 'calculated' && <p className="text-xs text-zinc-600">List calculated: E-Order cost ÷ 0.525</p>}{r.replaces.length > 0 && <p className="text-xs">Replaces {r.replaces.join(', ')}</p>}{r.replacedBy.length > 0 && <p className="text-xs">Replaced by {r.replacedBy.join(', ')}</p>}</td><td className="py-3 whitespace-nowrap">{money(r.previous)}</td><td className="py-3 whitespace-nowrap">{money(r.proposed)}</td><td className="py-3">{r.previous != null && r.proposed != null ? `${money(r.proposed-r.previous)}${r.previous > 0 ? ` (${((r.proposed/r.previous-1)*100).toFixed(1)}%)` : ''}` : '—'}</td><td className="p-3 max-w-sm">{r.reason || <button className={button} disabled={busy || stale || Boolean(data?.error)} onClick={() => setProposal(r)}>{r.kind === 'new' ? 'Review creation' : 'Review update'}</button>}{r.kind === 'archive' && <><p>Stock: {r.stock ?? 'Unknown'}</p><button className={button} disabled={busy || !r.eligibleForArchiveReview || r.stock !== 0} onClick={() => setProposal(r)}>Record completed archive</button></>}</td></tr>)}
    </tbody></table>{!rows.length && <p className="p-4">No matching proposals in the saved comparison.</p>}</div>
    {rows.length > limit && <button className={button} onClick={() => setLimit(limit+50)}>Show more</button>}
    {proposal && <section className="rounded border-2 border-sky-700 bg-white p-4" aria-label="Confirm item change"><h2 className="font-bold">{proposal.company === 'thanda-solar' ? 'Thanda' : 'Sensible'} · {proposal.sku}</h2><p className="my-3">{proposal.kind === 'archive' ? 'Confirm you checked outstanding orders, stock is zero, and you have completed archival in Xero.' : `${proposal.kind === 'new' ? 'Create product' : 'Update purchase cost'}: ${money(proposal.previous)} → ${money(proposal.proposed)}.${proposal.kind === 'new' ? ` Selling price: ${money(proposal.list)}.` : ''}`}</p><div className="flex gap-3"><button className={button} disabled={busy} onClick={() => action({ action: proposal.kind === 'archive' ? 'archive-reviewed' : 'apply', fingerprint: proposal.fingerprint, confirmed: true })}>{busy ? 'Working…' : 'Confirm'}</button><button className={button} disabled={busy} onClick={() => setProposal(null)}>Cancel</button></div></section>}
    <details className="rounded border bg-white p-4"><summary className="cursor-pointer font-semibold">Quarterly sanity check</summary><p className="my-3 text-sm">Check the official quarterly price list against E-Order, announced new products, phase-outs and article-number changes. Record discrepancies here; the quarterly list never overwrites E-Order prices. Q4 2026 highlights: Venus GX end of life; gradual Lithium Smart phase-out; new article numbers; November EV charger launches.</p><textarea aria-label="Quarterly check findings" className="w-full rounded border p-3" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Quarter, source/reference, checks performed and discrepancies…" /><button className={button} disabled={busy || note.trim().length < 10} onClick={() => action({ action: 'quarterly', note })}>Save check record</button></details>
    <details className="rounded border bg-white p-4"><summary className="cursor-pointer font-semibold">Recent audit history</summary><ul className="mt-3 space-y-2 text-sm">{data?.events.map((e,i) => <li key={i}>{new Date(e.created_at).toLocaleString('en-ZA')} · {e.action} · {e.company} {e.sku} · operator {e.actor}{e.details.note && <p>{e.details.note}</p>}{e.details.result?.error && <p className="text-amber-800">{e.details.result.error}</p>}{e.details.changes && <details><summary className="cursor-pointer">View {e.details.changes.length} saved changes</summary><ul>{e.details.changes.map(c => <li key={c.sku}>{c.sku}: {money(c.previous)} → {money(c.proposed)}</li>)}</ul></details>}</li>)}</ul></details>
  </div></main>;
}
