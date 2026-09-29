'use client';

import Link from 'next/link';
import { Eye, KeyRound, MailPlus, Pencil, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { InviteUserForm, type XeroStatus } from '@/components/admin/user-admin';
import { AdminMenu } from '@/components/admin/admin-menu';

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
  const [xeroStatus, setXeroStatus] = useState<XeroStatus | null>(null);
  const [xeroStatusError, setXeroStatusError] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resendingUserId, setResendingUserId] = useState<number | null>(null);
  const [resettingUserId, setResettingUserId] = useState<number | null>(null);
  const [viewingUserId, setViewingUserId] = useState<number | null>(null);

  async function loadUsers() {
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load users.');
    setUsers(data.users || []);
    setCanManageUsers(Boolean(data.canManageUsers));
  }

  async function loadXeroStatus() {
    const response = await fetch('/api/admin/xero/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load Xero status.');
    setXeroStatus(data);
    setXeroStatusError(false);
  }

  async function resendInvite(user: PortalUser) {
    setResendingUserId(user.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to resend invite.');
      setMessage(`A new account-setup email was sent to ${user.email}.`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend invite.');
    } finally {
      setResendingUserId(null);
    }
  }

  async function sendPasswordReset(user: PortalUser) {
    setResettingUserId(user.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, action: 'passwordReset' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to send password reset.');
      setMessage(`A password-reset email was sent to ${user.email}.`);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send password reset.');
    } finally {
      setResettingUserId(null);
    }
  }

  async function viewAs(user: PortalUser) {
    if (!window.confirm(`View the store as ${user.email} at ${user.organisation_name}? Your actions will be recorded as acting on their behalf.`)) return;
    setViewingUserId(user.id); setError('');
    try {
      const response = await fetch('/api/admin/impersonation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: user.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start customer view.');
      window.location.assign('/');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not start customer view.'); setViewingUserId(null); }
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
    async function loadInitialXeroStatus() {
      try { await loadXeroStatus(); }
      catch { if (active) setXeroStatusError(true); }
    }
    void loadInitialXeroStatus();
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
            <p className="text-sm text-zinc-500">Find a portal user, then open their account to manage their email, permissions and company membership.</p>
          </div>
          <AdminMenu />
        </div>

        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
        {message && <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</div>}
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {canManageUsers && <><Link href="/admin/companies#add-company" className="inline-flex h-10 items-center rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold">Add company</Link><a href="#add-user" className="inline-flex h-10 items-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">Add user</a></>}
          <Link href="/admin/settings" className={`inline-flex h-8 items-center rounded-full px-3 text-xs font-semibold ${xeroStatusError ? 'bg-amber-100 text-amber-900' : xeroStatus?.connected && !xeroStatus.reconnectRequired ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`} title="View Xero connection details in Settings">{xeroStatusError ? 'Xero status unavailable' : xeroStatus ? xeroStatus.connected && !xeroStatus.reconnectRequired ? 'Xero connected' : 'Xero needs attention' : 'Checking Xero…'}</Link>
        </div>

        {canManageUsers && <div id="add-user" className="mb-6 scroll-mt-6"><InviteUserForm onCreated={loadUsers} /></div>}

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
            <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,.75fr)_minmax(0,.75fr)_8.5rem] gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500 lg:grid">
              <span>Company</span><span>Email</span><span>Access</span><span>Status</span><span className="text-right">Actions</span>
            </div>
            {filteredUsers.map((user) => <div key={user.id} className="grid gap-2 border-b border-zinc-100 px-4 py-4 last:border-b-0 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,.75fr)_minmax(0,.75fr)_8.5rem] lg:items-center lg:gap-4">
              <div className="min-w-0"><p className="font-semibold">{user.organisation_name}</p>{user.xero_contact_name && user.xero_contact_name !== user.organisation_name && <p className="mt-1 text-xs text-zinc-500">Xero: {user.xero_contact_name}</p>}</div>
              <p className="min-w-0 break-all text-sm text-zinc-600">{user.email}</p>
              <p className="text-sm text-zinc-600">{user.role === 'admin' ? user.can_manage_users ? 'Admin · Users' : 'Administrator' : 'Buyer'}</p>
              <div className="flex flex-wrap gap-2"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${user.setup_expires_at ? 'bg-amber-100 text-amber-800' : user.is_active ? 'bg-green-100 text-green-800' : 'bg-zinc-200 text-zinc-700'}`}>{user.setup_expires_at ? 'Setup pending' : user.is_active ? 'Active' : 'Disabled'}</span></div>
              <div className="flex gap-2 lg:justify-self-end">
                {canManageUsers && user.role === 'buyer' && user.is_active && <button type="button" aria-label={`View store as ${user.email}`} title="View as customer" disabled={viewingUserId === user.id} onClick={() => void viewAs(user)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 text-zinc-900 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-60"><Eye size={18} aria-hidden="true" /></button>}
                {canManageUsers && user.setup_expires_at && <button type="button" aria-label={`Resend invitation to ${user.email}`} title="Resend invitation" disabled={resendingUserId === user.id} onClick={() => void resendInvite(user)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 text-zinc-900 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-60"><MailPlus size={18} aria-hidden="true" /></button>}
                {canManageUsers && user.is_active && !user.setup_expires_at && <button type="button" aria-label={`Send password reset to ${user.email}`} title="Send password reset" disabled={resettingUserId === user.id} onClick={() => void sendPasswordReset(user)} className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 text-zinc-900 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:opacity-60"><KeyRound size={18} aria-hidden="true" /></button>}
                <Link href={`/admin/users/${user.id}`} aria-label={`Edit ${user.email}`} title="Edit user" className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-300 text-zinc-900 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"><Pencil size={18} aria-hidden="true" /></Link>
              </div>
            </div>)}
            {users.length === 0 && <p className="p-4 text-sm text-zinc-500">Loading users...</p>}
            {users.length > 0 && filteredUsers.length === 0 && <p className="p-4 text-sm text-zinc-500">No users match that search.</p>}
          </div>
        </section>

      </div>
    </main>
  );
}
