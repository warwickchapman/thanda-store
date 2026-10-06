'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileText, RefreshCw, Search } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
type HistorySync = {
  pending: boolean;
  observedAt: string | null;
  lastError: string | null;
  hasSnapshot: boolean;
};

function titleCase(value: string) {
  return value.toLowerCase().replace(/(?:^|_)([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`).trim();
}

function money(document: CustomerDocument, amount: number) {
  return document.currency === 'ZAR' ? formatCurrency(amount) : `${document.currency} ${amount.toFixed(2)}`;
}

function accountDate(value: string | null) {
  if (!value) return 'No date';
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function historyDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Africa/Johannesburg',
  }).format(date);
}

async function accountResponse(response: Response, fallback: string) {
  if (response.status === 401 || (response.redirected && new URL(response.url).pathname === '/login')) {
    throw new Error('Your session has expired. Sign in again to view your account documents.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(fallback);
  }
  const data = await response.json().catch(() => { throw new Error(fallback); });
  if (!response.ok) throw new Error(data.error || fallback);
  return data;
}

function AccountsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusedQuote = searchParams.get('quote');
  const loadSequence = useRef(0);
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [tab, setTab] = useState<Tab>('current');
  const [search, setSearch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [openInvoices, setOpenInvoices] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [historySync, setHistorySync] = useState<HistorySync | null>(null);
  const [busyQuoteId, setBusyQuoteId] = useState<string | null>(null);

  const load = useCallback(async (refresh = false, requestedPage = page) => {
    const sequence = ++loadSequence.current;
    setRefreshing(refresh);
    setLoading(true);
    setLoadFailed(false);
    setMessage('');
    try {
      const params = new URLSearchParams({ page: String(requestedPage), view: tab });
      if (focusedQuote) params.set('quote', focusedQuote);
      if (searchTerm) params.set('query', searchTerm);
      if (refresh) params.set('refresh', '1');
      const response = await fetch(`/api/account/documents?${params.toString()}`);
      const data = await accountResponse(response, 'Unable to load account documents. Please try Refresh again.');
      if (sequence !== loadSequence.current) return;
      setDocuments(data.documents || []);
      setTotal(data.total || 0);
      setPage(data.page || requestedPage);
      setPageSize(data.pageSize || 25);
      setHistorySync(data.sync || null);
      setOpenInvoices(data.sync?.hasSnapshot === false ? null : data.openInvoices || 0);
    } catch (error) {
      if (sequence !== loadSequence.current) return;
      setDocuments([]);
      setTotal(0);
      setOpenInvoices(null);
      setLoadFailed(true);
      setMessage(error instanceof Error ? error.message : 'Unable to load account documents.');
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [page, tab, searchTerm, focusedQuote]);

  function clearQuoteFilter() {
    setPage(1);
    router.replace('/accounts', { scroll: false });
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchTerm(search.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(false, page); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, page]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const historyMessage = historySync?.lastError
    ? `${historySync.hasSnapshot ? 'Account history could not be refreshed. Showing saved documents.' : 'Account history could not be prepared.'} ${historySync.pending ? 'Another refresh remains queued; check again shortly.' : 'Please try Refresh again.'}`
    : historySync?.hasSnapshot === false
      ? 'Account history is being prepared. Check again shortly.'
      : historySync?.pending
        ? 'Account history refresh is queued. Showing saved documents; check again shortly.'
        : null;
  const savedHistoryDate = historyDate(historySync?.observedAt || null);
  const partialHistory = Boolean(historySync && (!historySync.hasSnapshot || historySync.pending || historySync.lastError));

  async function updateQuote(document: CustomerDocument, accept: boolean) {
    const action = accept ? 'accept' : 'mark unaccepted';
    if (!window.confirm(`Are you sure you want to ${action} quote ${document.number}?`)) return;
    setBusyQuoteId(document.id);
    setMessage('');
    try {
      const response = await fetch(`/api/account/quotes/${encodeURIComponent(document.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accept }),
      });
      const data = await accountResponse(response, 'Unable to update quote. Please try again.');
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

        {focusedQuote && <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <p className="text-zinc-600">Showing this quote</p>
          <button type="button" className="font-semibold underline underline-offset-4" onClick={clearQuoteFilter}>Clear quote filter</button>
        </div>}
        <section className="mt-6">
          <div className="border border-zinc-300 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Open invoices</p>
              <p className="mt-1 text-2xl font-bold">{openInvoices === null ? '—' : formatCurrency(openInvoices)}</p>
          </div>
        </section>

        <section className="mt-6 border border-zinc-300 bg-white">
          <div className="flex flex-col gap-3 border-b border-zinc-300 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex overflow-x-auto" role="tablist" aria-label="Account documents">
              {([
                ['current', 'Current'], ['quote', 'Quotes'], ['invoice', 'Invoices'], ['credit_note', 'Credit notes'],
              ] as Array<[Tab, string]>).map(([value, label]) => (
                <button key={value} role="tab" aria-selected={tab === value} onClick={() => { setTab(value); setPage(1); if (focusedQuote) clearQuoteFilter(); }} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold ${tab === value ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-900'}`}>{label}</button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <a href={historySync?.hasSnapshot ? '/api/account/statement' : undefined}
                aria-disabled={!historySync?.hasSnapshot}
                title={!historySync?.hasSnapshot ? 'Available once account history is prepared' : undefined}
                className={`inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-semibold ${historySync?.hasSnapshot ? 'hover:bg-zinc-50' : 'cursor-not-allowed opacity-40'}`}><Download className="h-4 w-4" />Statement CSV</a>
              <button onClick={() => void load(true)} disabled={loading} className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</button>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-b border-zinc-300 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search reference or document number..." className="h-10 w-full rounded-lg border border-zinc-300 bg-white pl-10 pr-3 text-sm outline-none focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900" />
            </div>
            {!loading && !loadFailed && <p className="text-sm text-zinc-500">{total.toLocaleString()} {partialHistory ? 'saved ' : ''}{total === 1 ? 'document' : 'documents'}</p>}
          </div>
          {!loading && !loadFailed && (historyMessage || savedHistoryDate) && <div className={`border-b border-zinc-300 px-4 py-3 text-sm text-zinc-600 ${historySync?.lastError || historySync?.hasSnapshot === false ? 'bg-amber-50' : 'bg-zinc-50'}`} role="status">
            {historyMessage && <p>{historyMessage}</p>}
            {savedHistoryDate && <p className={historyMessage ? 'mt-1' : ''}>Saved history as of {savedHistoryDate} SAST.</p>}
          </div>}
          {message && <p className="border-b border-zinc-300 bg-amber-50 px-4 py-3 text-sm text-zinc-800" role="status">{message}</p>}
          {loading ? <p className="p-8 text-sm text-zinc-500">Loading account documents...</p> : loadFailed ? null : documents.length === 0 ? <p className="p-8 text-sm text-zinc-500">{partialHistory ? 'No saved documents in this view yet.' : 'No documents in this view.'}</p> : (
            <div className="divide-y divide-zinc-200">
              {documents.map((document) => (
                <article key={`${document.type}-${document.id}`} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold">{document.number || 'Unnumbered document'}</p>
                      <span className="border border-zinc-300 px-2 py-0.5 text-xs font-semibold">{document.type === 'quote' && document.status === 'DRAFT' ? 'Quote requested' : titleCase(document.status || document.type)}</span>
                    </div>
                    <p className="mt-1 text-sm text-zinc-600">{accountDate(document.date)}{document.dueDate ? ` · Due ${accountDate(document.dueDate)}` : ''}{document.reference ? ` · ${document.reference}` : ''}</p>
                    <p className="mt-1 text-sm text-zinc-600">{titleCase(document.type)} · Total {money(document, document.total)}{document.type === 'invoice' && ` · Open ${money(document, document.due)}`}</p>
                  </div>
                  <a href={`/api/account/documents/${document.type}/${encodeURIComponent(document.id)}/pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50"><FileText className="h-4 w-4" />PDF <ExternalLink className="h-3.5 w-3.5" /></a>
                  {document.type === 'quote' && document.status === 'SENT' && <button disabled={busyQuoteId === document.id} onClick={() => void updateQuote(document, true)} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"><Check className="h-4 w-4" />Accept quote</button>}
                  {document.type === 'quote' && document.status === 'ACCEPTED' && <button disabled={busyQuoteId === document.id} onClick={() => void updateQuote(document, false)} className="inline-flex h-9 items-center justify-center rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-50">Mark unaccepted</button>}
                  {document.type === 'quote' && <Link href={`/accounts/quotes/${encodeURIComponent(document.id)}/copy`} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50"><Copy className="h-4 w-4" />Copy to new quote</Link>}
                </article>
              ))}
            </div>
          )}
          {!loading && total > 0 && <div className="flex items-center justify-between border-t border-zinc-300 p-4">
            <p className="text-sm text-zinc-500">Page {page} of {pageCount}</p>
            <div className="flex gap-2">
              <button onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1} className="inline-flex h-9 items-center gap-1 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-40"><ChevronLeft className="h-4 w-4" />Newer</button>
              <button onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount} className="inline-flex h-9 items-center gap-1 rounded-lg border border-zinc-300 px-3 text-sm font-semibold hover:bg-zinc-50 disabled:opacity-40">Older<ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>}
        </section>
      </div>
    </main>
  );
}

export default function AccountsPage() {
  return <Suspense fallback={<main className="min-h-screen bg-zinc-50 p-8 text-sm text-zinc-500">Loading account documents...</main>}><AccountsContent /></Suspense>;
}
