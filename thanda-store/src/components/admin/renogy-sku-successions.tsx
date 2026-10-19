'use client';

import { useState } from 'react';

type Product = { sku: string; name: string; hidden: boolean };
type Succession = { predecessorSku: string; successorSku: string; sourceDescription: string; firstSeenAt: string; lastSeenAt: string };
type Listing = { products: Product[]; successions: Succession[] };
const field = 'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-950';
const button = 'rounded-md border border-zinc-300 px-3 py-2 text-sm font-semibold hover:bg-zinc-100 disabled:opacity-50';
const normaliseSku = (value: string) => value.trim().toUpperCase();

async function responseData(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to complete this request.');
  return data;
}

export function RenogySkuSuccessions() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [predecessorSku, setPredecessorSku] = useState('');
  const [successorSku, setSuccessorSku] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function refresh() {
    setBusy(true); setError('');
    try { setListing(await responseData(await fetch('/api/admin/renogy-sku-successions', { cache: 'no-store' }))); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to load Renogy replacement links.'); }
    finally { setBusy(false); }
  }

  async function change(removing: boolean, previous: string, replacement: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await responseData(await fetch('/api/admin/renogy-sku-successions', {
        method: removing ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ predecessorSku: normaliseSku(previous), successorSku: normaliseSku(replacement) }),
      }));
      setMessage(result.message);
      if (!removing) { setPredecessorSku(''); setSuccessorSku(''); }
      setListing(await responseData(await fetch('/api/admin/renogy-sku-successions', { cache: 'no-store' })));
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to update the Renogy replacement link.'); }
    finally { setBusy(false); }
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const previous = listing?.products.find(product => normaliseSku(product.sku) === normaliseSku(predecessorSku));
    const replacement = listing?.products.find(product => !product.hidden && normaliseSku(product.sku) === normaliseSku(successorSku));
    if (!previous || !replacement || normaliseSku(previous.sku) === normaliseSku(replacement.sku)) {
      setError('Choose two different Renogy SKUs from the saved catalogue. The replacement must be a current product.');
      return;
    }
    void change(false, previous.sku, replacement.sku);
  }

  const previous = listing?.products.find(product => normaliseSku(product.sku) === normaliseSku(predecessorSku));
  const replacement = listing?.products.find(product => normaliseSku(product.sku) === normaliseSku(successorSku));
  return <details className="mt-6 rounded-lg border border-zinc-200 bg-white" onToggle={event => {
    if (event.currentTarget.open && !listing && !busy) void refresh();
  }}>
    <summary className="cursor-pointer px-4 py-4 text-sm font-semibold">Renogy SKU replacements</summary>
    <div className="border-t border-zinc-100 p-4">
      <p className="text-sm text-zinc-600">Record a confirmed replacement when Renogy changes an item code. The previous product stays available while it has trustworthy positive stock; otherwise the current replacement is shown. Stock, prices and sales history remain under their original SKUs.</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p id="renogy-sku-help" className="text-xs text-zinc-500">Search the saved Renogy catalogue by item code or name, then choose a SKU.</p>
        <button type="button" disabled={busy} className={button} onClick={() => void refresh()}>{busy ? 'Loading…' : 'Refresh'}</button>
      </div>
      {listing && <>
        <form className="mt-4" onSubmit={save}>
          <fieldset disabled={busy} className="grid items-start gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold">Previous SKU
              <input required maxLength={150} value={predecessorSku} onChange={event => setPredecessorSku(event.target.value)} list="renogy-previous-skus" autoComplete="off" aria-describedby="renogy-sku-help" placeholder="Search previous item" className={field} />
              {previous && <span className="mt-1 block text-xs font-normal text-zinc-500">{previous.name}{previous.hidden ? ' · Hidden' : ''}</span>}
            </label>
            <label className="text-sm font-semibold">Replacement SKU
              <input required maxLength={150} value={successorSku} onChange={event => setSuccessorSku(event.target.value)} list="renogy-replacement-skus" autoComplete="off" aria-describedby="renogy-sku-help" placeholder="Search current item" className={field} />
              {replacement && <span className="mt-1 block text-xs font-normal text-zinc-500">{replacement.name}</span>}
            </label>
          </fieldset>
          <datalist id="renogy-previous-skus">{listing.products.map(product => <option key={product.sku} value={product.sku}>{product.name}</option>)}</datalist>
          <datalist id="renogy-replacement-skus">{listing.products.filter(product => !product.hidden).map(product => <option key={product.sku} value={product.sku}>{product.name}</option>)}</datalist>
          <div className="mt-3 flex justify-end"><button disabled={busy || !predecessorSku.trim() || !successorSku.trim()} className="rounded-md bg-zinc-950 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">Save replacement</button></div>
        </form>
        {listing.successions.length > 0 ? <ul className="mt-5 divide-y divide-zinc-100 border-t border-zinc-200">{listing.successions.map(succession => <li key={succession.predecessorSku} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0"><p className="break-all text-sm font-semibold">{succession.predecessorSku} <span aria-label="replaced by">→</span> {succession.successorSku}</p><p className="mt-1 text-xs text-zinc-500">{succession.sourceDescription} · {new Date(succession.firstSeenAt).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' })}</p></div>
          <button type="button" disabled={busy} className={button} aria-label={`Remove replacement link from ${succession.predecessorSku} to ${succession.successorSku}`} onClick={() => void change(true, succession.predecessorSku, succession.successorSku)}>Remove</button>
        </li>)}</ul> : <p className="mt-5 text-sm text-zinc-500">No Renogy replacement links have been recorded.</p>}
      </>}
      {message && <p role="status" className="mt-3 rounded-md bg-green-50 p-3 text-sm text-green-900">{message}</p>}
      {error && <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    </div>
  </details>;
}
