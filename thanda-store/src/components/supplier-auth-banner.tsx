'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

type Alert = { source_id: string; opened_at: string; email_failed: number; email_accepted: number; email_pending: number };

export function SupplierAuthBanner() {
  const pathname = usePathname();
  const isLogin = ['/login', '/forgot-password', '/set-password', '/request-quote'].includes(pathname);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (isLogin) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    async function load() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      clearTimeout(timer);
      try {
        const response = await fetch('/api/admin/supplier-auth-alerts', { cache: 'no-store', signal: controller.signal });
        if (response.status === 403) { setAlerts([]); setUnavailable(false); return; }
        if (!response.ok) throw new Error('Unavailable');
        setAlerts((await response.json()).alerts); setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        loading = false;
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 60_000);
    }
    function focus() { if (document.visibilityState === 'visible') void load(); }
    void load();
    window.addEventListener('focus', focus);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('focus', focus); };
  }, [isLogin, pathname]);
  if (isLogin || !alerts.length) return null;
  return <aside role="alert" aria-label="Supplier authentication alert" className="border-b border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950">
    <div className="mx-auto max-w-7xl space-y-1">
      {alerts.map(alert => <p key={alert.source_id}><strong>{alert.source_id === 'renogy' ? 'Renogy' : 'Supplier'} login needs attention.</strong> Supplier stock updates cannot continue. Ask the Store maintainer to restore the partner login. {alert.email_failed > 0 ? 'Email alert delivery also needs attention.' : alert.email_pending > 0 || !alert.email_accepted ? 'Administrator email alerts are pending.' : 'Administrator email alerts have been accepted.'}</p>)}
      <Link href="/admin/data-health" className="inline-block font-semibold underline">Review data health</Link>
      {unavailable && <p className="text-xs">The latest alert status could not be checked. The last known alert remains visible.</p>}
    </div>
  </aside>;
}
