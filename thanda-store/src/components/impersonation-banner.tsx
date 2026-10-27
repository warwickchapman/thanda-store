'use client';

import { useState } from 'react';
import { useStoreSession } from '@/components/store-session';

export function ImpersonationBanner() {
  const { user } = useStoreSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!user?.impersonatedBy) return null;
  async function stop() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/impersonation', { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not return to your account.');
      window.location.assign('/admin/users');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not return to your account.'); setBusy(false); }
  }
  return <div role="status" className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-2 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-950">
    <span><strong>Viewing as {user.email}</strong> · {user.organisationName} · Acting admin: {user.impersonatedBy.email}</span>
    <button type="button" onClick={() => void stop()} disabled={busy} className="rounded border border-amber-700 px-2 py-1 font-semibold disabled:opacity-60">{busy ? 'Returning…' : 'Return to admin'}</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
