'use client';
import Link from 'next/link';
import { useEffect,useState } from 'react';
type RequestRow={id:string;created_at:string;completed_at:string|null;quote_number:string|null;company:string;buyer:string;last_error:string|null;notifications:Array<{audience:string;state:string;attempts:number;providerId:string|null;error:string|null}>};
export default function QuoteRequestsPage(){
  const [rows,setRows]=useState<RequestRow[]>([]);const [error,setError]=useState('');const [cooldown,setCooldown]=useState<string|null>(null);
  async function load(){try{const r=await fetch('/api/admin/quote-requests');const d=await r.json();if(!r.ok)throw new Error(d.error);setRows(d.requests);setCooldown(d.provider?.next_allowed_at && new Date(d.provider.next_allowed_at).getTime()>Date.now()?d.provider.next_allowed_at:null);setError('');}catch(e){setError(e instanceof Error?e.message:'Unable to load requests.');}}
  useEffect(()=>{const timer=setTimeout(()=>void load(),0);return()=>clearTimeout(timer);},[]);
  return <main className="mx-auto w-full min-w-0 max-w-5xl space-y-5 px-4 py-8"><header className="flex justify-between gap-4"><h1 className="text-2xl font-bold">Quote requests & notifications</h1><Link href="/admin/users" className="underline">Admin</Link></header>
    <p className="text-sm text-zinc-600">Unresolved requests and email issues appear first. Retrying email never creates another quote. Accepted means the provider accepted the email; delivered is confirmed separately.</p>
    <button onClick={()=>void load()} className="rounded-lg border px-4 py-2">Refresh status</button>
    {error&&<p role="alert">{error}</p>}{cooldown&&<p role="status" className="bg-amber-50 p-3">Email sending is paused until {new Date(cooldown).toLocaleString()} after a provider limit or configuration error.</p>}
    {rows.map(r=><article key={r.id} className="space-y-2 rounded-xl border bg-white p-4"><h2 className="font-bold">{r.quote_number||'Awaiting quote confirmation'} · {r.company}</h2><p className="text-sm text-zinc-600">{r.buyer} · {new Date(r.created_at).toLocaleString()}</p><p className="break-all text-xs text-zinc-500">Request {r.id}</p>{r.last_error&&<p role="alert" className="text-amber-800">{r.last_error}</p>}
      {r.notifications.map(n=><div key={n.audience} className="border-t pt-2 text-sm"><strong>{n.audience==='buyer'?'Customer receipt':'Sales notification'}: {n.state}</strong> · {n.attempts} send attempts{n.error&&<p className="text-amber-800">{n.error}</p>}{n.providerId&&<p className="break-all text-xs text-zinc-500">Provider ID: {n.providerId}</p>}</div>)}
      {r.notifications.some(n=>['failed','unconfirmed'].includes(n.state))&&<p className="text-sm text-zinc-600">Review the provider record and contact the customer if necessary. No new quote is needed.</p>}
    </article>)}{!rows.length&&!error&&<p>No recorded quote requests.</p>}
  </main>;
}
