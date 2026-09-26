import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { validRequestId } from '@/lib/commerce/quote-requests.mjs';

export default async function QuoteConfirmationPage({ searchParams }: { searchParams: Promise<{ requestId?: string }> }) {
  const user=await currentUser();
  if (!user) redirect('/login');
  const {requestId}=await searchParams;
  if (!validRequestId(requestId)) redirect('/accounts');
  const result=await pool.query(`SELECT r.quote_id,r.quote_payload,n.state FROM portal_quote_requests r
    LEFT JOIN portal_quote_notifications n ON n.request_id=r.id AND n.audience='buyer'
    WHERE r.id=$1 AND r.contact_id=$2 AND r.completed_at IS NOT NULL`,[requestId,user.xeroContactId]);
  const row=result.rows[0];
  if (!row) notFound();
  const quote=row.quote_payload;
  const receipt=row.state==='delivered'?'The confirmation email was delivered.'
    :row.state==='accepted'?'Your confirmation email has been submitted for delivery.'
    :row.state==='pending'?'Your confirmation email is queued. Your request is already saved in Accounts.'
    :'We could not confirm delivery of the email. Your request is saved in Accounts and the sales team can see the notification issue.';
  return <main className="min-h-screen bg-zinc-50 px-4 py-12"><section className="mx-auto max-w-xl rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8">
    <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">Quote request received</p>
    <h1 className="mt-2 text-3xl font-bold">Thank you for your quote request.</h1>
    <dl className="mt-6 space-y-2 rounded-xl bg-amber-50 p-5"><dt>Quote number</dt><dd className="text-xl font-bold">{quote.QuoteNumber || quote.QuoteID}</dd><dt>Your reference</dt><dd className="font-semibold">{quote.Reference || 'Not supplied'}</dd></dl>
    <p className="mt-6 text-sm leading-6 text-zinc-600">The Thanda sales team will send the final quotation shortly and confirm acceptance with you.</p>
    <p className="mt-3 text-sm text-zinc-600">{receipt}</p>
    <div className="mt-8 flex flex-wrap gap-3"><Link href={`/accounts?quote=${encodeURIComponent(row.quote_id)}`} className="rounded-lg bg-zinc-950 px-4 py-3 text-sm font-semibold text-white">View this request in Accounts</Link><Link href="/" className="rounded-lg border px-4 py-3 text-sm font-semibold">Continue shopping</Link></div>
  </section></main>;
}
