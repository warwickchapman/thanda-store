'use client';

import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CheckCircle2, MapPin, Package, Plus, Trash2 } from 'lucide-react';
import type { PublicProduct } from '@/lib/commerce/public-storefront';

type Line = { productId: number; quantity: number };
const inputClass = 'mt-2 block min-h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base focus:border-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-200';

export function GuestQuoteForm({ products, initialIds, initialQuantity }: { products: PublicProduct[]; initialIds: number[]; initialQuantity: number }) {
  const [lines, setLines] = useState<Line[]>(() => [...new Set(initialIds)].filter(id => products.some(product => product.id === id)).map(productId => ({ productId, quantity: initialIds.length === 1 && Number.isInteger(initialQuantity) ? initialQuantity : 1 })));
  const [addId, setAddId] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const operation = useRef({ id: '', startedAt: 0 });
  const available = products.filter(product => !lines.some(line => line.productId === product.id));

  function startForm() {
    if (!operation.current.id) operation.current = { id: crypto.randomUUID(), startedAt: Date.now() };
  }

  function addProduct() {
    const productId = Number(addId || available[0]?.id);
    if (available.some(product => product.id === productId)) {
      setLines(current => [...current, { productId, quantity: 1 }]); setAddId('');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startForm();
    const data = new FormData(event.currentTarget);
    const body = { requestId: operation.current.id, startedAt: operation.current.startedAt, website: data.get('website') || '',
      contact: { name: data.get('name'), email: data.get('email'), phone: data.get('phone'), company: data.get('company'), town: data.get('town') },
      deliveryPreference: data.get('deliveryPreference'), message: data.get('message'), lines };
    setSending(true); setError('');
    try {
      const response = await fetch('/api/public/quote-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || typeof payload?.reference !== 'string') throw new Error(payload?.error || 'We could not confirm your enquiry. Please retry the form or contact the team.');
      setReceipt(payload.reference);
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== 'TimeoutError' ? failure.message : 'We could not confirm that your enquiry was saved. Please retry this form; its reference will stay the same.');
    } finally { setSending(false); }
  }

  if (receipt) return <main className="mx-auto w-full max-w-3xl space-y-5 px-6 py-16"><CheckCircle2 className="h-12 w-12 text-emerald-700" aria-hidden="true" /><p className="text-sm font-semibold uppercase tracking-widest text-amber-700">Thanda Solar · KZN</p><h1 className="text-4xl font-bold tracking-tight">Your enquiry is with us.</h1><p className="text-lg leading-relaxed text-zinc-600">The Thanda team will review your selection and contact you to confirm pricing, availability and delivery or collection.</p><p className="rounded-xl border border-zinc-200 bg-white p-4 text-sm">Your reference<br /><strong className="break-all font-mono">{receipt}</strong></p><p className="text-sm text-zinc-600">This is a quote enquiry. Stock is not reserved and no order or payment has been created.</p><div className="flex flex-wrap gap-4"><a href="https://thanda.solar" className="rounded-lg bg-zinc-900 px-5 py-3 font-semibold text-white">Back to Thanda Solar</a><a href="mailto:sales@thanda.solar" className="px-2 py-3 font-semibold underline underline-offset-4">Contact the team</a></div></main>;

  return <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14"><header className="mb-9 max-w-2xl"><p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-amber-700"><MapPin size={15} aria-hidden="true" /> Ballito, KwaZulu-Natal</p><h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Let’s put your quote together.</h1><p className="mt-4 text-lg leading-relaxed text-zinc-600">Choose your equipment and tell us where you need it. Our local team will confirm pricing, stock and delivery. No account needed.</p></header>
    <form onSubmit={submit} onFocusCapture={startForm} onPointerDownCapture={startForm} className="grid items-start gap-8 lg:grid-cols-[1.45fr_1fr]">
      <div className="space-y-7"><section aria-labelledby="quote-products" className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6"><h2 id="quote-products" className="text-xl font-bold">Your products</h2>
        {!products.length && <p className="mt-4 text-zinc-600">The featured selection is being updated. Tell us what you need in the message box and our team will help.</p>}
        {!lines.length && products.length > 0 && <p className="mt-3 text-sm text-zinc-600">Add a product below, or describe what you need in your message.</p>}
        <ul className="divide-y divide-zinc-100">{lines.map(line => { const product = products.find(item => item.id === line.productId)!; return <li key={line.productId} className="py-5"><div className="flex gap-4"><div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-zinc-50 p-2">{product.imageUrl ? <img src={product.imageUrl} alt="" className="max-h-full max-w-full object-contain" /> : <Package size={30} className="text-zinc-300" aria-hidden="true" />}</div><div className="min-w-0 flex-1"><p className="font-semibold leading-snug">{product.name}</p><p className="mt-1 break-all text-xs text-zinc-500">{product.sku}</p><p className="mt-2 text-xs text-zinc-600">{product.availability.local === 'in_stock' ? 'KZN stock available · subject to confirmation' : 'We’ll confirm availability with your quote'}</p></div></div><div className="mt-4 flex items-center justify-between gap-3"><label className="flex items-center gap-3 text-sm font-medium">Quantity<input type="number" min="1" max="100" step="1" required value={line.quantity || ''} onChange={event => setLines(current => current.map(item => item.productId === line.productId ? { ...item, quantity: Number(event.target.value) } : item))} aria-label={`Quantity for ${product.name}`} className="h-11 w-20 rounded-lg border border-zinc-300 px-3" /></label><button type="button" onClick={() => setLines(current => current.filter(item => item.productId !== line.productId))} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-zinc-600 hover:bg-zinc-100" aria-label={`Remove ${product.name}`}><Trash2 size={15} aria-hidden="true" />Remove</button></div></li>; })}</ul>
        {available.length > 0 && <div className="mt-4 flex flex-col gap-3 border-t border-zinc-100 pt-5 sm:flex-row"><label className="min-w-0 flex-1 text-sm font-medium">Add another product<select className={inputClass} value={addId || String(available[0]?.id || '')} onChange={event => setAddId(event.target.value)}>{available.map(product => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label><button type="button" onClick={addProduct} className="flex min-h-11 shrink-0 items-center justify-center gap-2 self-end rounded-lg border border-zinc-300 px-4 text-sm font-semibold"><Plus size={16} aria-hidden="true" /> Add</button></div>}
      </section>
      <section aria-labelledby="quote-contact" className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6"><h2 id="quote-contact" className="mb-5 text-xl font-bold">Your details</h2><div className="grid gap-5 sm:grid-cols-2"><label className="text-sm font-medium">Your name<input name="name" autoComplete="name" required maxLength={120} className={inputClass} /></label><label className="text-sm font-medium">Email address<input name="email" type="email" autoComplete="email" required maxLength={254} className={inputClass} /></label><label className="text-sm font-medium">Phone <span className="font-normal text-zinc-500">(optional)</span><input name="phone" type="tel" autoComplete="tel" maxLength={40} className={inputClass} /></label><label className="text-sm font-medium">Company <span className="font-normal text-zinc-500">(optional)</span><input name="company" autoComplete="organization" maxLength={160} className={inputClass} /></label><label className="text-sm font-medium sm:col-span-2">Town or postcode<input name="town" autoComplete="address-level2" required maxLength={120} className={inputClass} /></label></div></section></div>
      <aside className="space-y-6 rounded-2xl bg-zinc-100 p-5 sm:p-6 lg:sticky lg:top-6"><h2 className="text-xl font-bold">Local help, from the start.</h2><p className="text-sm leading-relaxed text-zinc-600">Speak to the team supplying your equipment. We’ll help with product questions and arrange local delivery or collection where available.</p><label className="block text-sm font-medium">How would you like to receive it?<select name="deliveryPreference" defaultValue="discuss" className={inputClass}><option value="discuss">Discuss with the team</option><option value="deliver">Delivery</option><option value="collect">Collection in Ballito</option></select></label><label className="block text-sm font-medium">{lines.length ? 'Anything else we should know?' : 'Tell us what you need'} <span className="font-normal text-zinc-500">{lines.length ? '(optional)' : '(required)'}</span><textarea name="message" rows={4} required={!lines.length} maxLength={2000} className={inputClass} placeholder="Your application, delivery needs, or a product question…" /></label>
        <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
        <button type="submit" disabled={sending} className="flex min-h-12 w-full items-center justify-center gap-3 rounded-lg bg-amber-500 px-5 py-3 font-bold text-zinc-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50">{sending ? 'Saving your enquiry…' : 'Request my quote'}<ArrowRight size={18} aria-hidden="true" /></button><p className="text-xs leading-relaxed text-zinc-600">We’ll use your details to respond to this enquiry. Submitting does not subscribe you to marketing, reserve stock or place an order.</p><div className="border-t border-zinc-200 pt-5 text-sm"><p className="font-semibold">Prefer to speak to us?</p><a href="tel:+27656912951" className="mt-2 inline-block underline underline-offset-4">+27 65 691 2951</a><br /><a href="mailto:sales@thanda.solar" className="mt-2 inline-block underline underline-offset-4">sales@thanda.solar</a></div>
      </aside>
    </form>
  </main>;
}
