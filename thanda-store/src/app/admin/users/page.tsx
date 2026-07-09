'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type AdminUser = {
  id: number;
  username: string;
  email: string;
  role: string;
  organisation_id: number;
  organisation_name: string;
  xero_contact_id: string | null;
  xero_contact_name: string | null;
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
    async function run() {
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
        if (active) setError(err instanceof Error ? err.message : 'Failed to load users');
      }
    }
    run();
    return () => {
      active = false;
    };
  }, []);

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

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold">User Admin</h1>
            <p className="text-sm text-zinc-500">Link store organisations to Xero contacts.</p>
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
                <p className="font-bold">
                  Xero: {xeroStatus.connected ? xeroStatus.tenantName || 'Connected' : 'Not connected'}
                </p>
                {xeroStatus.connected && !xeroStatus.reconnectRequired ? (
                  <p className="mt-1">Connected with the required contact and organisation permissions.</p>
                ) : (
                  <p className="mt-1">
                    Reconnect is required{xeroStatus.missingScopes.length ? ` for: ${xeroStatus.missingScopes.join(', ')}` : ''}.
                  </p>
                )}
                {xeroStatus.grantedScopes?.length > 0 && (
                  <p className="mt-2 break-words text-xs opacity-75">
                    Granted: {xeroStatus.grantedScopes.join(', ')}
                  </p>
                )}
                {xeroStatus.reconnectRequired && (
                  <p className="mt-2 text-xs opacity-75">
                    After approving in Xero, return here and refresh status.
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    loadXeroStatus().catch((err) => setError(err instanceof Error ? err.message : 'Failed to refresh Xero status'));
                  }}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900"
                >
                  Refresh status
                </button>
                {(!xeroStatus.connected || xeroStatus.reconnectRequired) && (
                  <a
                    href="/api/admin/xero/connect"
                    className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white"
                  >
                    Reconnect Xero
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-2">
          {users.map((user) => (
            <form
              key={user.id}
              action={(formData) => saveLink(user, formData)}
              className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
            >
              <div className="mb-4 grid gap-1">
                <div className="flex flex-col justify-between gap-1 sm:flex-row">
                  <h2 className="font-bold">{user.organisation_name}</h2>
                  <span className="text-sm text-zinc-500">{user.username} · {user.email} · {user.role}</span>
                </div>
                <p className="text-sm text-zinc-500">
                  Discounts: Victron {user.discounts?.victron ?? 0}% · Renogy {user.discounts?.renogy ?? 0}%
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <label className="grid gap-1 text-sm font-semibold">
                  Xero Contact ID
                  <input
                    name="xeroContactId"
                    defaultValue={user.xero_contact_id || ''}
                    className="h-10 rounded-md border border-zinc-300 px-3 font-normal"
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold">
                  Xero Contact Name
                  <input
                    name="xeroContactName"
                    defaultValue={user.xero_contact_name || ''}
                    className="h-10 rounded-md border border-zinc-300 px-3 font-normal"
                  />
                </label>
                <button className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">
                  Save
                </button>
              </div>
            </form>
          ))}
        </div>
      </div>
    </main>
  );
}
