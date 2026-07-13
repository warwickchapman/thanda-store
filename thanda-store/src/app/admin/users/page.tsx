'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type AdminUser = {
  id: number;
  username: string;
  email: string;
  role: string;
  is_active: boolean;
  organisation_id: number;
  organisation_name: string;
  xero_contact_id: string | null;
  xero_contact_name: string | null;
  setup_expires_at: string | null;
  discounts: Record<string, number>;
};

type XeroStatus = {
  connected: boolean;
  tenantName: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  reconnectRequired: boolean;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [xeroStatus, setXeroStatus] = useState<XeroStatus | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busyUserId, setBusyUserId] = useState<number | null>(null);

  async function loadUsers() {
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load users');
    setUsers(data.users || []);
  }

  async function loadXeroStatus() {
    const response = await fetch('/api/admin/xero/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load Xero status');
    setXeroStatus(data);
  }

  useEffect(() => {
    let active = true;
    async function loadInitialData() {
      try {
        const [usersResponse, xeroResponse] = await Promise.all([
          fetch('/api/admin/users', { cache: 'no-store' }),
          fetch('/api/admin/xero/status', { cache: 'no-store' }),
        ]);
        const usersData = await usersResponse.json();
        const xeroData = await xeroResponse.json();
        if (!usersResponse.ok) throw new Error(usersData.error || 'Failed to load users');
        if (!xeroResponse.ok) throw new Error(xeroData.error || 'Failed to load Xero status');
        if (active) {
          setUsers(usersData.users || []);
          setXeroStatus(xeroData);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load user administration');
      }
    }
    void loadInitialData();
    return () => {
      active = false;
    };
  }, []);

  async function createUser(formData: FormData) {
    setError('');
    setMessage('');
    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organisationName: formData.get('organisationName'),
        username: formData.get('username'),
        email: formData.get('email'),
        xeroContactId: formData.get('xeroContactId'),
        xeroContactName: formData.get('xeroContactName'),
        victronDiscount: formData.get('victronDiscount'),
        renogyDiscount: formData.get('renogyDiscount'),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Failed to create user');
      return;
    }
    setMessage(data.inviteSent ? 'User created and account setup email sent.' : 'User created, but the setup email could not be sent. Use Send setup email after resolving Resend.');
    await loadUsers();
  }

  async function saveLink(user: AdminUser, formData: FormData) {
    setError('');
    setMessage('');
    const response = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organisationId: user.organisation_id,
        xeroContactId: formData.get('xeroContactId'),
        xeroContactName: formData.get('xeroContactName'),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Failed to save Xero link');
      return;
    }
    setMessage('Xero contact link saved.');
    await loadUsers();
  }

  async function sendSetupEmail(user: AdminUser) {
    setBusyUserId(user.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to send setup email');
      setMessage(`A password setup email was sent to ${user.email}.`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send setup email');
    } finally {
      setBusyUserId(null);
    }
  }

  async function setActive(user: AdminUser, isActive: boolean) {
    setBusyUserId(user.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setActive', userId: user.id, isActive }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update account status');
      setMessage(isActive ? 'Account enabled.' : 'Account disabled.');
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update account status');
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold">User Admin</h1>
            <p className="text-sm text-zinc-500">Create portal users, link Xero contacts, and manage account setup.</p>
          </div>
          <Link href="/" className="text-sm font-semibold text-zinc-700">Back to store</Link>
        </div>

        {message && <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</div>}
        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

        {xeroStatus && (
          <div className={`mb-6 rounded-lg border p-4 text-sm shadow-sm ${
            xeroStatus.connected && !xeroStatus.reconnectRequired
              ? 'border-green-200 bg-green-50 text-green-900'
              : 'border-amber-200 bg-amber-50 text-amber-950'
          }`}>
            <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
              <div className="min-w-0">
                <p className="font-bold">Xero: {xeroStatus.connected ? xeroStatus.tenantName || 'Connected' : 'Not connected'}</p>
                <p className="mt-1">
                  {xeroStatus.connected && !xeroStatus.reconnectRequired
                    ? 'Connected with the required contact and organisation permissions.'
                    : `Reconnect is required${xeroStatus.missingScopes.length ? ` for: ${xeroStatus.missingScopes.join(', ')}` : ''}.`}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button type="button" onClick={() => loadXeroStatus().catch((err) => setError(err instanceof Error ? err.message : 'Failed to refresh Xero status'))} className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900">Refresh status</button>
                {(!xeroStatus.connected || xeroStatus.reconnectRequired) && <a href="/api/admin/xero/connect" className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">Reconnect Xero</a>}
              </div>
            </div>
          </div>
        )}

        <section className="mb-8 border-b border-zinc-200 pb-8">
          <div className="mb-4">
            <h2 className="text-lg font-bold">Invite a buyer</h2>
            <p className="text-sm text-zinc-500">The buyer chooses their own password from a one-time email link, then signs in with email OTP.</p>
          </div>
          <form action={createUser} className="grid gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm lg:grid-cols-6">
            <label className="grid gap-1 text-sm font-semibold lg:col-span-2">Company<input name="organisationName" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
            <label className="grid gap-1 text-sm font-semibold lg:col-span-2">Username<input name="username" required pattern="[A-Za-z0-9._-]{3,64}" className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
            <label className="grid gap-1 text-sm font-semibold lg:col-span-2">Email<input name="email" type="email" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
            <label className="grid gap-1 text-sm font-semibold lg:col-span-3">Xero Contact ID<input name="xeroContactId" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
            <label className="grid gap-1 text-sm font-semibold lg:col-span-3">Xero Contact Name<input name="xeroContactName" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
            <label className="grid gap-1 text-sm font-semibold">Victron discount<input name="victronDiscount" type="number" min="0" max="40" step="0.01" defaultValue="30" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
            <label className="grid gap-1 text-sm font-semibold">Renogy discount<input name="renogyDiscount" type="number" min="0" max="40" step="0.01" defaultValue="30" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
            <div className="flex items-end lg:col-span-4"><button className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">Create and send setup email</button></div>
          </form>
        </section>

        <section>
          <div className="mb-4 flex items-end justify-between border-b border-zinc-200 pb-3">
            <div><h2 className="text-lg font-bold">Portal users</h2><p className="text-sm text-zinc-500">Setup email also acts as a password reset.</p></div>
            <span className="text-sm text-zinc-500">{users.length} users</span>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {users.map((user) => (
              <div key={user.id} className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row">
                  <div>
                    <h3 className="font-bold">{user.organisation_name}</h3>
                    <p className="text-sm text-zinc-500">{user.username} · {user.email} · {user.role}</p>
                    <p className="mt-1 text-sm text-zinc-500">Discounts: Victron {user.discounts?.victron ?? 0}% · Renogy {user.discounts?.renogy ?? 0}%</p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${user.is_active ? 'bg-green-100 text-green-800' : 'bg-zinc-200 text-zinc-700'}`}>{user.is_active ? 'Active' : 'Disabled'}</span>
                    {user.setup_expires_at && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">Setup pending</span>}
                  </div>
                </div>

                <form action={(formData) => saveLink(user, formData)} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <label className="grid gap-1 text-sm font-semibold">Xero Contact ID<input name="xeroContactId" defaultValue={user.xero_contact_id || ''} className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
                  <label className="grid gap-1 text-sm font-semibold">Xero Contact Name<input name="xeroContactName" defaultValue={user.xero_contact_name || ''} className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
                  <button className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">Save link</button>
                </form>

                <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-100 pt-4">
                  <button type="button" disabled={busyUserId === user.id} onClick={() => sendSetupEmail(user)} className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60">Send setup email</button>
                  <button type="button" disabled={busyUserId === user.id} onClick={() => setActive(user, !user.is_active)} className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60">{user.is_active ? 'Disable account' : 'Enable account'}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
