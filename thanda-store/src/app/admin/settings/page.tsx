'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type XeroStatus, XeroStatusPanel } from '@/components/admin/user-admin';

export default function AdminSettingsPage() {
  const [xeroStatus, setXeroStatus] = useState<XeroStatus | null>(null);
  const [draftsOnly, setDraftsOnly] = useState<boolean | null>(null);
  const [savingQuoteSetting, setSavingQuoteSetting] = useState(false);
  const [xeroError, setXeroError] = useState('');
  const [quoteError, setQuoteError] = useState('');

  async function loadXeroStatus() {
    const response = await fetch('/api/admin/xero/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load Xero status.');
    setXeroStatus(data);
    setXeroError('');
  }

  async function loadQuoteSettings() {
    const response = await fetch('/api/admin/quote-settings', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load quote settings.');
    setDraftsOnly(Boolean(data.draftsOnly));
    setQuoteError('');
  }

  async function updateDraftsOnly(nextDraftsOnly: boolean) {
    if (!nextDraftsOnly && !window.confirm('New client quote requests will be created as SENT quotes in Xero. Continue?')) return;
    setSavingQuoteSetting(true);
    setQuoteError('');
    try {
      const response = await fetch('/api/admin/quote-settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftsOnly: nextDraftsOnly }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update quote settings.');
      setDraftsOnly(Boolean(data.draftsOnly));
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : 'Failed to update quote settings.');
    } finally {
      setSavingQuoteSetting(false);
    }
  }

  useEffect(() => {
    async function loadInitialSettings() {
      await Promise.all([
        loadXeroStatus().catch((error) => setXeroError(error instanceof Error ? error.message : 'Failed to load Xero status.')),
        loadQuoteSettings().catch((error) => setQuoteError(error instanceof Error ? error.message : 'Failed to load quote settings.')),
      ]);
    }
    void loadInitialSettings();
  }, []);

  return <main className="min-h-screen bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-zinc-200 pb-4"><div><h1 className="text-2xl font-bold">Settings</h1><p className="text-sm text-zinc-500">Xero connection and quote creation</p></div><Link href="/admin/users" className="text-sm font-semibold underline">Back to User Admin</Link></header>
    {xeroError && <p role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{xeroError} <button type="button" className="underline" onClick={() => void loadXeroStatus().catch((error) => setXeroError(error instanceof Error ? error.message : 'Failed to load Xero status.'))}>Retry</button></p>}
    {xeroStatus && <XeroStatusPanel xeroStatus={xeroStatus} onRefresh={() => void loadXeroStatus().catch((error) => setXeroError(error instanceof Error ? error.message : 'Failed to refresh Xero status.'))} />}
    {quoteError && <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{quoteError} <button type="button" className="underline" onClick={() => void loadQuoteSettings().catch((error) => setQuoteError(error instanceof Error ? error.message : 'Failed to load quote settings.'))}>Retry</button></p>}
    {draftsOnly !== null && <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><h2 className="font-bold">Quote creation</h2><p className="mt-1 text-sm text-zinc-600">{draftsOnly ? 'New client quote requests create DRAFT quotes in Xero.' : 'New client quote requests create SENT quotes in Xero.'}</p></div><label className="flex items-center gap-3 text-sm font-semibold"><input type="checkbox" checked={draftsOnly} disabled={savingQuoteSetting} onChange={(event) => void updateDraftsOnly(event.target.checked)} className="h-5 w-5 rounded border-zinc-300" />Send quotes as drafts only</label></div></section>}
  </div></main>;
}
