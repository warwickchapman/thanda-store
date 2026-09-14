'use client';

import Link from 'next/link';
import { Check, Download, ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatCurrency } from '@/lib/utils';

type DocumentType = 'quote' | 'invoice' | 'credit_note';
type CustomerDocument = {
  type: DocumentType;
  id: string;
  number: string;
  status: string;
  date: string | null;
  dueDate: string | null;
  reference: string;
  currency: string;
  total: number;
  paid: number;
  due: number;
};

type Tab = 'current' | 'invoice' | 'quote' | 'credit_note';

function titleCase(value: string) {
  return value.toLowerCase().replace(/(?:^|_)([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`).trim();
}

function money(document: CustomerDocument, amount: number) {
  return document.currency === 'ZAR' ? formatCurrency(amount) : `${document.currency} ${amount.toFixed(2)}`;
}

export default function AccountsPage() {
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [tab, setTab] = useState<Tab>('current');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [busyQuoteId, setBusyQuoteId] = useState<string | null>(null);

  async function load(refresh = false) {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setMessage('');
    try {
      const response = await fetch(`/api/account/documents${refresh ? '?refresh=1' : ''}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load account documents.');
      setDocuments(data.documents || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load account documents.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const filtered = useMemo(() => documents.filter((document) => {
    if (tab === 'current') return (document.type === 'invoice' && document.due > 0) || (document.type === 'quote' && ['SENT', 'ACCEPTED'].includes(document.status));
    return document.type === tab;
  }), [documents, tab]);
  const openInvoices = documents.filter((document) => document.type === 'invoice').reduce((total, document) => total + document.due, 0);
  const creditAvailable = documents.filter((document) => document.type === 'credit_note').reduce((total, document) => total + document.due, 0);

  async function updateQuote(document: CustomerDocument, accept: boolean) {
    const action = accept ? 'accept' : 'mark unaccepted';
    if (!window.confirm(`Are you sure you want to ${action} quote ${document.number}?`)) return;
    setBusyQuoteId(document.id);
    setMessage('');
    try {
      const response = await fetch(`/api/account/quotes/${encodeURIComponent(document.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update quote.');
      setMessage(data.message);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update quote.');
    } finally {
      setBusyQuoteId(null);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-6 text-zinc-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-4 border-b border-zinc-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-500">Thanda Store</p>
            <h1 className="text-3xl font-bold tracking-tight">Accounts</h1>
            <p className="mt-1 text-sm text-zinc-600">Your company quotes, invoices, credit notes, and account statement.</p>
          </div>
          <Link href="/" className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-300 px-4 text-sm font-semibold hover:bg-white">Back to store</Link>
        </header>

        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="border border-zinc-300 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Open invoices</p>
            <p className="mt-1 text-2xl font-bold">{formatCurrency(openInvoices)}</p>
          </div>
          <div className="border border-zinc-300 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Credit available</p>
            <p className="mt-1 text-2xl font-bold">{formatCurrency(creditAvailable)}</p>
          </div>
        </section>

        <section className="mt-6 border border-zinc-300 bg-white">
          <div className="flex flex-col gap-3 border-b border-zinc-300 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex overflow-x-auto" role="tablist" aria-label="Account documents">
              {([
                ['current', 'Current'], ['invoice', 'Invoices'], ['quote', 'Quotes'], ['credit_note', 'Credit notes'],
              ] as Array<[Tab, string]>).map(([value, label]) => (
                <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${tab === value ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-900'}`}>{label}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <a href="/api/account/statement" className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50"><Download className="h-4 w-4" />Statement CSV</a>
              <button onClick={() => void load(true)} disabled={refreshing} className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button>
            </div>
          </div>
          {message && <p className="border-b border-zinc-300 bg-amber-50 px-4 py-3 text-sm text-zinc-800" role="status">{message}</p>}
          {loading ? <p className="p-8 text-sm text-zinc-500">Loading account documents...</p> : filtered.length === 0 ? <p className="p-8 text-sm text-zinc-500">No documents in this view.</p> : (
            <div className="divide-y divide-zinc-200">
              {filtered.map((document) => (
                <article key={`${document.type}-${document.id}`} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold">{document.number || 'Unnumbered document'}</p>
                      <span className="border border-zinc-300 px-2 py-0.5 text-xs font-semibold">{titleCase(document.status || document.type)}</span>
                    </div>
                    <p className="mt-1 text-sm text-zinc-600">{document.date || 'No date'}{document.dueDate ? ` · Due ${document.dueDate}` : ''}{document.reference ? ` · ${document.reference}` : ''}</p>
                    <p className="mt-1 text-sm text-zinc-600">{titleCase(document.type)} · Total {money(document, document.total)}{document.type === 'invoice' && ` · Open ${money(document, document.due)}`}</p>
                  </div>
                  <a href={`/api/account/documents/${document.type}/${encodeURIComponent(document.id)}/pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50"><FileText className="h-4 w-4" />PDF <ExternalLink className="h-3.5 w-3.5" /></a>
                  {document.type === 'quote' && document.status === 'SENT' && <button disabled={busyQuoteId === document.id} onClick={() => void updateQuote(document, true)} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"><Check className="h-4 w-4" />Accept quote</button>}
                  {document.type === 'quote' && document.status === 'ACCEPTED' && <button disabled={busyQuoteId === document.id} onClick={() => void updateQuote(document, false)} className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">Mark unaccepted</button>}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
