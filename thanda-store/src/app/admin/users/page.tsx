'use client';

import Link from 'next/link';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { InviteUserForm } from '@/components/admin/user-admin';

type PortalUser = {
  id: number;
  email: string;
  role: string;
  can_manage_users: boolean;
  is_active: boolean;
  xero_contact_name: string | null;
  organisation_name: string;
  setup_expires_at: string | null;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  async function loadUsers() {
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load users.');
    setUsers(data.users || []);
    setCanManageUsers(Boolean(data.canManageUsers));
  }

  useEffect(() => {
    let active = true;
    async function loadInitialUsers() {
      try {
        await loadUsers();
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load users.');
      }
    }
    void loadInitialUsers();
    return () => {
      active = false;
    };
  }, []);

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return users;
    return users.filter((user) => [user.organisation_name, user.email, user.xero_contact_name, user.role, user.is_active ? 'active' : 'disabled'].some((value) => value?.toLowerCase().includes(term)));
  }, [query, users]);

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold">User Admin</h1>
            <p className="text-sm text-zinc-500">Find a portal user, then open their account to manage access and Xero linking.</p>
          </div>
          <Link href="/" className="text-sm font-semibold text-zinc-700">Back to store</Link>
        </div>

        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

        <section>
          <div className="mb-4 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-3 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-lg font-bold">Portal users</h2>
              <p className="text-sm text-zinc-500">{filteredUsers.length} of {users.length} users</p>
            </div>
            <label className="relative block sm:w-80">
              <span className="sr-only">Search users</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search company or email" className="h-10 w-full rounded-md border border-zinc-300 bg-white pl-9 pr-3 text-sm" />
            </label>
          </div>

          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
            <div className="hidden grid-cols-[minmax(12rem,1.5fr)_minmax(14rem,1.5fr)_minmax(8rem,1fr)_minmax(7rem,.7fr)_auto] gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 lg:grid">
              <span>Company</span><span>Email</span><span>Access</span><span>Status</span><span className="text-right">Action</span>
            </div>
            {filteredUsers.map((user) => <div key={user.id} className="grid gap-2 border-b border-zinc-100 px-4 py-4 last:border-b-0 lg:grid-cols-[minmax(12rem,1.5fr)_minmax(14rem,1.5fr)_minmax(8rem,1fr)_minmax(7rem,.7fr)_auto] lg:items-center lg:gap-4">
              <div><p className="font-semibold">{user.organisation_name}</p>{user.xero_contact_name && user.xero_contact_name !== user.organisation_name && <p className="mt-1 text-xs text-zinc-500">Xero: {user.xero_contact_name}</p>}</div>
              <p className="break-all text-sm text-zinc-600">{user.email}</p>
              <p className="text-sm text-zinc-600">{user.role === 'admin' ? user.can_manage_users ? 'Admin · Users' : 'Administrator' : 'Buyer'}</p>
              <div className="flex flex-wrap gap-2"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${user.is_active ? 'bg-green-100 text-green-800' : 'bg-zinc-200 text-zinc-700'}`}>{user.is_active ? 'Active' : 'Disabled'}</span>{user.setup_expires_at && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">Setup pending</span>}</div>
              <Link href={`/admin/users/${user.id}`} className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900 lg:justify-self-end">Edit</Link>
            </div>)}
            {users.length === 0 && <p className="p-4 text-sm text-zinc-500">Loading users...</p>}
            {users.length > 0 && filteredUsers.length === 0 && <p className="p-4 text-sm text-zinc-500">No users match that search.</p>}
          </div>
        </section>

        {canManageUsers && <InviteUserForm onCreated={loadUsers} />}
      </div>
    </main>
  );
}
