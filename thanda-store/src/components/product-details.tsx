'use client';
import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {formatCurrency} from '@/lib/utils';
type Detail={description:string;specifications:Array<{label:string;value:string}>;links:Array<{kind:string;title:string;url:string}>};
type Product={id:number;name:string;sku:string;your_price_ex_vat:number|null};
export function ProductDetails({product,stock,onClose}:{product:Product;stock:string[];onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);const [detail,setDetail]=useState<Detail|null>(null);const [error,setError]=useState('');
  useEffect(()=>{const el=dialog.current;const focus=document.activeElement as HTMLElement|null;el?.showModal();const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{el?.close();document.body.style.overflow=overflow;focus?.focus();};},[]);
  useEffect(()=>{const controller=new AbortController();fetch(`/api/products/${product.id}`,{signal:controller.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);setDetail(d);}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[product.id]);
  return <dialog ref={dialog} aria-labelledby="product-title" onCancel={onClose} onClick={e=>{if(e.target===dialog.current)onClose();}} className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-xl border-0 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/30"><div className="flex h-full flex-col">
    <header className="flex items-start justify-between gap-3 border-b p-5"><div><p className="text-xs font-semibold text-zinc-500">{product.sku}</p><h2 id="product-title" className="mt-2 text-xl font-bold">{product.name}</h2></div><button autoFocus aria-label="Close product details" onClick={onClose} className="rounded p-2 hover:bg-zinc-100"><X/></button></header>
    <div className="space-y-6 overflow-y-auto p-5"><section><p className="text-xs text-zinc-500">Your company price excluding VAT</p><p className="mt-1 text-2xl font-bold text-amber-600">{product.your_price_ex_vat===null?'Price on request':formatCurrency(product.your_price_ex_vat)}</p><div className="mt-3 space-y-1 text-sm text-zinc-600">{stock.map(s=><p key={s}>{s}</p>)}</div></section>
      {error&&<p role="alert">{error}</p>}{!detail&&!error&&<p role="status">Loading product details…</p>}
      {detail&&<><section><h3 className="font-bold">Description</h3><p className="mt-2 whitespace-pre-line text-sm leading-6">{detail.description}</p></section>
        {!!detail.specifications.length&&<section><h3 className="mb-2 font-bold">Specifications</h3><dl className="divide-y">{detail.specifications.map((s,i)=><div key={`${s.label}-${i}`} className="grid grid-cols-2 gap-4 py-2 text-sm"><dt className="text-zinc-500">{s.label}</dt><dd className="break-words">{s.value}</dd></div>)}</dl></section>}
        <section><h3 className="font-bold">Manufacturer resources</h3>{detail.links.length?<ul className="mt-2 space-y-3">{detail.links.map(l=><li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer" className="text-sm underline"><span className="font-semibold">{l.kind==='product'?'Product page':l.kind==='datasheet'?'Datasheet':'Manual'}:</span> {l.title}</a></li>)}</ul>:<p className="mt-2 text-sm text-zinc-500">No verified manufacturer links are available for this product yet.</p>}</section></>}
    </div></div></dialog>;
}
