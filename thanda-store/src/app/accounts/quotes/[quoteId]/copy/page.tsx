'use client';

import Link from 'next/link';
import { Minus, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';

type Line = { productId: number; sku: string; name: string; quantity: number; unitPrice: number; discount: number };
type Product = { id: number; sku: string; name: string; your_price_ex_vat: number | null };

export default function CopyQuotePage({ params }: { params: Promise<{ quoteId: string }> }) {
  const [quoteId, setQuoteId] = useState('');
  const [quoteNumber, setQuoteNumber] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void params.then(async ({ quoteId: id }) => {
      setQuoteId(id);
      const response = await fetch(`/api/account/quotes/${encodeURIComponent(id)}/copy`);
      const data = await response.json();
      if (!response.ok) setMessage(data.error || 'Unable to open quote.');
      else { setQuoteNumber(data.quoteNumber || ''); setLines(data.lines || []); setSkipped(data.skipped || []); }
      setLoading(false);
    });
  }, [params]);

  useEffect(() => {
    if (search.trim().length < 2) return;
    const timer = window.setTimeout(async () => {
      const response = await fetch(`/api/products?query=${encodeURIComponent(search.trim())}`);
      const data = await response.json();
      setProducts(response.ok ? data : []);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  function changeQuantity(productId: number, quantity: number) {
    if (quantity <= 0) setLines((current) => current.filter((line) => line.productId !== productId));
    else setLines((current) => current.map((line) => line.productId === productId ? { ...line, quantity } : line));
  }

  function addProduct(product: Product) {
    if (product.your_price_ex_vat === null) return;
    const unitPrice = product.your_price_ex_vat;
    setLines((current) => {
      const existing = current.find((line) => line.productId === product.id);
      return existing ? current.map((line) => line.productId === product.id ? { ...line, quantity: line.quantity + 1 } : line) : [...current, { productId: product.id, sku: product.sku, name: product.name, quantity: 1, unitPrice, discount: 0 }];
    });
    setSearch('');
    setProducts([]);
  }

  async function save() {
    setSaving(true); setMessage('');
    try {
      const storageKey = `thanda-copy-request-${quoteId}`;
      const requestId = sessionStorage.getItem(storageKey) || crypto.randomUUID();
      sessionStorage.setItem(storageKey, requestId);
      const response = await fetch(`/api/account/quotes/${encodeURIComponent(quoteId)}/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines, requestId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to create copied draft quote.');
      sessionStorage.removeItem(storageKey);
      window.location.assign(`/quotes/confirmation?requestId=${encodeURIComponent(data.requestId)}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to create copied draft quote.'); }
    finally { setSaving(false); }
  }

  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  return <main className="min-h-screen bg-zinc-50 px-4 py-6 text-zinc-900 sm:px-6"><div className="mx-auto max-w-3xl">
    <header className="flex items-end justify-between border-b border-zinc-300 pb-5"><div><p className="text-sm font-medium text-zinc-500">Accounts / Quotes</p><h1 className="text-3xl font-bold">Copy quote{quoteNumber ? ` ${quoteNumber}` : ''}</h1><p className="mt-1 text-sm text-zinc-600">Review quantities, add current products, then create a new draft quote.</p></div><Link href="/accounts" className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-semibold hover:bg-white">Back</Link></header>
    {loading ? <p className="py-8 text-sm text-zinc-500">Loading quote lines...</p> : <><section className="mt-6 border border-zinc-300 bg-white p-4"><label className="text-sm font-semibold">Add product</label><div className="relative mt-2"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search SKU or product name..." className="h-10 w-full rounded-lg border border-zinc-300 pl-10 pr-3 text-sm" /></div>{search.trim().length >= 2 && products.length > 0 && <div className="mt-2 divide-y border border-zinc-200">{products.map((product) => <button key={product.id} onClick={() => addProduct(product)} className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-sm hover:bg-zinc-50"><span><b>{product.sku}</b> · {product.name}</span><span>{product.your_price_ex_vat === null ? 'POA' : formatCurrency(product.your_price_ex_vat)}</span></button>)}</div>}</section>
    {skipped.length > 0 && <p className="mt-4 border border-amber-300 bg-amber-50 p-3 text-sm">These source SKUs are no longer in the live catalogue and could not be copied: {skipped.join(', ')}.</p>}
    <section className="mt-4 divide-y border border-zinc-300 bg-white">{lines.length === 0 ? <p className="p-5 text-sm text-zinc-500">Add at least one current product.</p> : lines.map((line) => <div key={line.productId} className="flex flex-wrap items-center gap-3 p-4"><div className="min-w-[12rem] flex-1"><p className="font-bold">{line.sku}</p><p className="text-sm text-zinc-600">{line.name}</p><p className="text-sm text-orange-700">{formatCurrency(line.unitPrice)} excl. VAT</p></div><div className="flex items-center border border-zinc-300"><button aria-label={`Decrease ${line.sku}`} onClick={() => changeQuantity(line.productId, line.quantity - 1)} className="p-2 hover:bg-zinc-50"><Minus className="h-4 w-4" /></button><span className="w-9 text-center text-sm font-semibold">{line.quantity}</span><button aria-label={`Increase ${line.sku}`} onClick={() => changeQuantity(line.productId, line.quantity + 1)} className="p-2 hover:bg-zinc-50"><Plus className="h-4 w-4" /></button></div><button aria-label={`Remove ${line.sku}`} onClick={() => changeQuantity(line.productId, 0)} className="p-2 text-zinc-500 hover:text-red-700"><Trash2 className="h-4 w-4" /></button></div>)}</section>
    <footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-300 pt-4"><p className="text-lg font-bold">New quote total: {formatCurrency(total)} excl. VAT</p><button disabled={saving || lines.length === 0} onClick={() => void save()} className="h-10 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50">{saving ? 'Creating draft quote...' : 'Create new draft quote'}</button></footer>{message && <p className="mt-4 border border-zinc-300 bg-white p-3 text-sm" role="status">{message}</p>}</>}</div></main>;
}
