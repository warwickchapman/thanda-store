'use client';

import { useEffect, useState } from 'react';
import { AdminMenu } from './admin-menu';

type XeroItem = {
  itemId: string; sku: string; name: string; description: string; price: string | number;
  existing: { id: number; editable: boolean; hidden: boolean } | null;
  replaces: string[]; replacedBy: string[];
};
type StoreProduct = { id: number; sku: string; name: string; description: string; price: string; category: string; image_url: string; hidden: boolean };
type Draft = { id?: number; itemId?: string; sku: string; name: string; description: string; price: string | number; category: string; image_url?: string; hidden?: boolean };
const field = 'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-normal text-zinc-950';
const button = 'rounded-md border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-100 disabled:opacity-50';

async function readResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to complete this request.');
  return data;
}

function ProductEditor({ draft, onCancel, onSaved }: { draft: Draft; onCancel: () => void; onSaved: (message: string) => void }) {
  const [preview, setPreview] = useState(draft.image_url || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    return () => { if (preview.startsWith('blob:')) URL.revokeObjectURL(preview); };
  }, [preview]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('visible', form.get('visible') === 'on' ? 'true' : 'false');
    if (draft.id) form.set('id', String(draft.id));
    else form.set('itemId', draft.itemId!);
    setBusy(true); setError('');
    try {
      const data = await readResponse(await fetch('/api/admin/products', { method: draft.id ? 'PATCH' : 'POST', body: form }));
      onSaved(data.message);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to save the product.'); }
    finally { setBusy(false); }
  }

  return <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
    <h2 className="text-lg font-bold">{draft.id ? 'Edit store product' : 'Prepare your store product'}</h2>
    <p className="mt-1 text-sm text-zinc-500">Xero item code: <strong className="text-zinc-700">{draft.sku}</strong>. Changes here are saved in the Store.</p>
    <form onSubmit={submit} className="mt-5">
      <fieldset disabled={busy} className="grid gap-6 md:grid-cols-[15rem_1fr]">
        <div>
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50">
            {/* Uploaded photos and stored media are already bounded and converted by the server. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {preview ? <img src={preview} alt="Product photograph preview" className="h-full w-full object-contain" /> : <span className="text-sm text-zinc-400">No photograph yet</span>}
          </div>
          <label className="mt-3 block text-sm font-semibold">Product photograph
            <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" className="mt-2 block w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-zinc-100 file:p-2 file:font-semibold" onChange={event => {
              const file = event.target.files?.[0] || null;
              if (file && file.size > 8 * 1024 * 1024) { setError('Choose a photo smaller than 8 MB.'); event.target.value = ''; setPreview(draft.image_url || ''); return; }
              setError(''); setPreview(file ? URL.createObjectURL(file) : draft.image_url || '');
            }} />
          </label>
          <p className="mt-2 text-xs text-zinc-500">JPG, PNG or WebP. Up to 8 MB and 25 megapixels. {draft.image_url ? 'Leave empty to keep the current photo.' : 'You can add a photo later.'}</p>
        </div>
        <div className="space-y-4">
          <label className="block text-sm font-semibold">Store name<input name="name" required maxLength={200} defaultValue={draft.name} className={field} /></label>
          <div><label htmlFor="store-product-description" className="block text-sm font-semibold">Description</label><textarea id="store-product-description" name="description" required maxLength={10000} rows={6} defaultValue={draft.description} className={`${field} text-sm`} /></div>
          <label className="block text-sm font-semibold">Category<input name="category" list="store-product-categories" required maxLength={100} defaultValue={draft.category} className={field} /></label>
          <datalist id="store-product-categories">{['Batteries', 'Solar panels', 'Inverters', 'Solar charge controllers', 'Cables & connectors', 'Monitoring', 'Other accessories', 'Other products'].map(category => <option key={category} value={category} />)}</datalist>
          <label className="block text-sm font-semibold">Selling price (ZAR, excluding VAT)<input name="price" type="number" required min="0.01" max="9999999999.99" step="0.01" defaultValue={draft.price} className={field} /></label>
          <p className="text-sm text-zinc-500">This is the final unit price before VAT. Company discounts do not reduce it. Confirm the suggested Xero price before saving.</p>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" name="visible" defaultChecked={!draft.hidden} className="h-4 w-4" />Visible in the store</label>
          <p className="text-xs text-zinc-500">Listed under Thanda. Stock follows the saved Xero inventory; untracked items show stock unknown.</p>
        </div>
      </fieldset>
      {error && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <div className="mt-6 flex justify-end gap-3 border-t border-zinc-100 pt-4">
        <button type="button" disabled={busy} className={button} onClick={onCancel}>Cancel</button>
        <button type="submit" disabled={busy} className="rounded-md bg-zinc-950 px-5 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">{busy ? 'Saving…' : draft.id ? 'Save changes' : 'Add to store'}</button>
      </div>
    </form>
  </section>;
}

export function StoreProductsAdmin() {
  const [tab, setTab] = useState<'xero' | 'store'>('xero');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ items: XeroItem[]; total: number; observedAt: string } | null>(null);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [storeFilter, setStoreFilter] = useState('');

  async function loadStore(editId?: number) {
    setBusy(true); setError('');
    try {
      const data = await readResponse(await fetch('/api/admin/products?source=store', { cache: 'no-store' }));
      setProducts(data.products);
      if (editId) {
        const product = data.products.find((item: StoreProduct) => Number(item.id) === editId);
        if (!product) throw new Error('This product is no longer available for editing.');
        setDraft(product);
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to load store products.'); }
    finally { setBusy(false); }
  }

  async function search(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage(''); setResults(null);
    try { setResults(await readResponse(await fetch(`/api/admin/products?q=${encodeURIComponent(query.trim())}`, { cache: 'no-store' }))); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to search the saved Xero listing.'); }
    finally { setBusy(false); }
  }

  const filtered = products.filter(product => `${product.sku} ${product.name}`.toLowerCase().includes(storeFilter.toLowerCase().trim()));
  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-zinc-200 pb-4"><div><h1 className="text-2xl font-bold">Products</h1><p className="text-sm text-zinc-500">Add products from Xero and prepare them for your store.</p></div><AdminMenu /></header>
    {message && <p role="status" className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900">{message}</p>}
    {draft ? <ProductEditor key={draft.id || draft.itemId} draft={draft} onCancel={() => setDraft(null)} onSaved={saved => { setDraft(null); setMessage(saved); setTab('store'); setResults(null); void loadStore(); }} /> : <>
      <div className="mb-5 flex gap-2" aria-label="Product source">
        <button type="button" disabled={busy} aria-pressed={tab === 'xero'} onClick={() => { setTab('xero'); setError(''); }} className={`${button} ${tab === 'xero' ? 'bg-zinc-200' : 'bg-white'}`}>Add from Xero</button>
        <button type="button" disabled={busy} aria-pressed={tab === 'store'} onClick={() => { setTab('store'); void loadStore(); }} className={`${button} ${tab === 'store' ? 'bg-zinc-200' : 'bg-white'}`}>Added from Xero</button>
      </div>
      {tab === 'xero' ? <section>
        <form onSubmit={search} className="rounded-lg border border-zinc-200 bg-white p-4">
          <label htmlFor="xero-product-query" className="text-sm font-semibold">Find a Xero product or service</label>
          <div className="mt-2 flex gap-2"><input id="xero-product-query" required minLength={2} maxLength={100} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search item code, name or description" className={`${field} mt-0 min-w-0`} /><button disabled={busy} className={button}>{busy ? 'Searching…' : 'Search'}</button></div>
          <p className="mt-2 text-xs text-zinc-500">Searches the saved Thanda Xero products and services marked for sale. Newly created Xero items appear after the next sync.</p>
        </form>
        {results && <>
          <p className="my-4 text-sm text-zinc-500">{results.total} matching {results.total === 1 ? 'item' : 'items'}{results.total > 50 ? ' · Showing the first 50; narrow your search for more.' : ''} · Xero observed {new Date(results.observedAt).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} SAST</p>
          {!results.items.length && <p className="rounded-lg border border-zinc-200 bg-white p-5 text-sm">No matching items. Try another code or name, or check that the item is marked for sale in Xero.</p>}
          <ul className="space-y-2">{results.items.map(item => <li key={item.itemId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4">
            <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-zinc-500">{item.sku}</p><h2 className="font-semibold">{item.name}</h2><p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-zinc-500">{item.description}</p>
              {item.replacedBy.length > 0 && <p className="mt-1 text-xs text-amber-800">Replaced by {item.replacedBy.join(', ')}. Check the current item before adding this code.</p>}
              {item.replaces.length > 0 && <p className="mt-1 text-xs text-zinc-500">Replaces {item.replaces.join(', ')}.</p>}
              {item.existing && <p className="mt-1 text-xs text-zinc-500">Already in catalogue{item.existing.hidden ? ' · Hidden from store' : ''}</p>}
            </div>
            {item.existing ? item.existing.editable && <button type="button" disabled={busy} className={button} onClick={() => void loadStore(item.existing!.id)}>Edit product</button> : <button type="button" className={button} onClick={() => { setMessage(''); setDraft({ ...item, category: 'Other products' }); }}>Select item</button>}
          </li>)}</ul>
        </>}
      </section> : <section>
        <p className="mb-3 text-sm text-zinc-500">Products added through this page. Supplier-managed catalogue products keep their existing import process.</p>
        <label className="text-sm font-semibold">Find an added product<input value={storeFilter} onChange={event => setStoreFilter(event.target.value)} placeholder="Item code or name" className={field} /></label>
        {busy ? <p role="status" className="py-5 text-sm">Loading products…</p> : !error && <ul className="mt-4 space-y-2">{filtered.map(product => <li key={product.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white p-4"><div><p className="text-xs text-zinc-500">{product.sku} · {product.hidden ? 'Hidden' : 'Visible'}</p><h2 className="font-semibold">{product.name}</h2><p className="mt-1 text-sm text-zinc-500">{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(product.price))} excl. VAT</p></div><button className={button} onClick={() => { setMessage(''); setDraft(product); }}>Edit product</button></li>)}{!filtered.length && <li className="rounded-lg border border-zinc-200 bg-white p-5 text-sm">{products.length ? 'No matching products.' : 'No products added here yet. Use Add from Xero to get started.'}</li>}</ul>}
      </section>}
      {error && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">{error} {tab === 'store' && <button type="button" className="underline" onClick={() => void loadStore()}>Retry</button>}</p>}
    </>}
  </div></main>;
}
