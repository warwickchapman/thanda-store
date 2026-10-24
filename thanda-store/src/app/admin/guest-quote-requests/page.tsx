'use client';

import { useEffect, useState } from 'react';
import { AdminMenu } from '@/components/admin/admin-menu';

type Enquiry = { id: string; created_at: string; updated_at: string; status: string; contact: { name: string; email: string; phone: string; company: string; town: string }; lines: Array<{ productId: number; name: string; sku: string; quantity: number }>; delivery_preference: string; message: string; notes: string; notification_state: string | null; notification_attempts: number | null; notification_error: string | null };
const statuses = [{ value: 'new', label: 'New' }, { value: 'in_review', label: 'In review' }, { value: 'quoted', label: 'Quoted' }, { value: 'closed', label: 'Closed' }];

function EnquiryCard({ enquiry, onSaved }: { enquiry: Enquiry; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState(enquiry.status);
  const [notes, setNotes] = useState(enquiry.notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/admin/guest-quote-requests', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: enquiry.id, status, notes }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || 'Unable to save the enquiry.');
      await onSaved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save.'); }
    finally { setSaving(false); }
  }
  return <article className="space-y-5 rounded-xl border border-zinc-200 bg-white p-5"><header className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-bold">{enquiry.contact.company || enquiry.contact.name}</h2><p className="mt-1 text-sm text-zinc-600">{enquiry.contact.name} · {enquiry.contact.town}</p></div><p className="text-sm text-zinc-500">{new Date(enquiry.created_at).toLocaleString()}</p></header><div className="flex flex-wrap gap-x-6 gap-y-2 text-sm"><a href={`mailto:${enquiry.contact.email}`} className="underline">{enquiry.contact.email}</a>{enquiry.contact.phone && <span>{enquiry.contact.phone}</span>}<span>Preference: {enquiry.delivery_preference}</span></div><ul className="space-y-2 border-y border-zinc-100 py-4">{enquiry.lines.map(line => <li key={line.productId} className="text-sm"><strong>{line.quantity} × {line.name}</strong><span className="ml-2 break-all text-zinc-500">{line.sku}</span></li>)}</ul>{enquiry.message && <p className="whitespace-pre-wrap text-sm text-zinc-700">{enquiry.message}</p>}<p className="text-xs text-zinc-500">Sales notification: <strong>{enquiry.notification_state || 'not queued'}</strong> · {enquiry.notification_attempts || 0} send attempts{enquiry.notification_error && <span className="block text-amber-900">{enquiry.notification_error}</span>}</p><div className="grid gap-4 sm:grid-cols-[10rem_1fr]"><label className="text-sm font-medium">Status<select value={status} onChange={event => setStatus(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-zinc-300 px-3">{statuses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="text-sm font-medium">Staff notes<textarea value={notes} onChange={event => setNotes(event.target.value)} maxLength={2000} rows={2} className="mt-2 w-full rounded-lg border border-zinc-300 p-3" /></label></div>{error && <p role="alert" className="text-sm text-red-800">{error}</p>}<div className="flex flex-wrap items-center justify-between gap-4"><p className="break-all font-mono text-xs text-zinc-500">{enquiry.id}</p><button onClick={() => void save()} disabled={saving || (status === enquiry.status && notes === enquiry.notes)} className="min-h-11 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white disabled:opacity-40">{saving ? 'Saving…' : 'Save changes'}</button></div></article>;
}

export default function WebsiteEnquiriesPage() {
  const [requests, setRequests] = useState<Enquiry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  async function load() {
    try {
      const response = await fetch('/api/admin/guest-quote-requests', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload?.requests)) throw new Error(payload?.error || 'Unable to load website enquiries.');
      setRequests(payload.requests); setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to load website enquiries.'); setRequests([]); }
    finally { setLoading(false); }
  }
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, []);
  const shown = requests.filter(item => filter === 'all' || ['new', 'in_review'].includes(item.status));
  return <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8"><header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-bold">Website enquiries</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-600">Review the customer, product selection and delivery needs before preparing a formal quotation. These enquiries have not created a Xero contact, quote or order.</p></div><AdminMenu /></header><div className="flex flex-wrap gap-3"><select value={filter} onChange={event => setFilter(event.target.value)} aria-label="Filter enquiries" className="min-h-11 rounded-lg border border-zinc-300 bg-white px-3"><option value="active">New & in review</option><option value="all">All recent enquiries</option></select><button onClick={() => void load()} className="min-h-11 rounded-lg border border-zinc-300 px-4 text-sm font-semibold">Refresh</button></div>{error && <p role="alert" className="rounded-lg bg-red-50 p-4 text-sm text-red-900">{error}</p>}{loading && <p role="status" className="text-sm text-zinc-600">Loading enquiries…</p>}{shown.map(enquiry => <EnquiryCard key={`${enquiry.id}:${enquiry.updated_at}`} enquiry={enquiry} onSaved={load} />)}{!loading && !error && !shown.length && <p className="rounded-xl border border-zinc-200 bg-white p-6 text-zinc-600">No enquiries in this view.</p>}<p className="text-xs text-zinc-500">The most recent 100 enquiries are shown, with active enquiries first. Notification acceptance and delivery are separate states.</p></main>;
}
