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

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function loadUsers() {
    const response = await fetch('/api/admin/users');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load users');
    setUsers(data.users || []);
  }

  useEffect(() => {
    let active = true;
    async function run() {
      try {
        const response = await fetch('/api/admin/users');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load users');
        if (active) setUsers(data.users || []);
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
    <main className="mx-auto min-h-screen max-w-6xl bg-zinc-50 px-4 py-6 text-zinc-950 sm:px-6">
      <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold">User Admin</h1>
          <p className="text-sm text-zinc-500">Link store organisations to Xero contacts.</p>
        </div>
        <Link href="/" className="text-sm font-semibold text-zinc-700">Back to store</Link>
      </div>

      {message && <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</div>}
      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      <div className="space-y-4">
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
    </main>
  );
}
