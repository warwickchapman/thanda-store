'use client';

import Link from 'next/link';
import { ApiAccess, UserCompany, type Company } from './company-access';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AdminMenu } from './admin-menu';

export type AdminUser = {
  id: number;
  email: string;
  role: string;
  can_manage_users: boolean;
  api_enabled: boolean;
  is_active: boolean;
  xero_person_kind: 'manual' | 'primary' | 'additional';
  archived_at: string | null;
  organisation_id: number;
  organisation_name: string;
  xero_contact_id: string | null;
  xero_contact_name: string | null;
  setup_expires_at: string | null;
  discounts: Record<string, number>;
};

function UserAccessEditor({
  user,
  busy,
  onSave,
}: {
  user: AdminUser;
  busy: boolean;
  onSave: (role: 'buyer' | 'admin', canManageUsers: boolean) => void;
}) {
  const [role, setRole] = useState<'buyer' | 'admin'>(
    user.role === 'admin' ? 'admin' : 'buyer',
  );
  const [canManageUsers, setCanManageUsers] = useState(user.can_manage_users);
  const hasChanges = role !== user.role || (role === 'admin' && canManageUsers) !== user.can_manage_users;
  return (
    <div className="mb-4 grid gap-3 border-b border-zinc-100 pb-4">
      <label className="grid gap-1 text-sm font-semibold">
        Access level
        <select
          value={role}
          onChange={(event) => {
            const nextRole = event.target.value === 'admin' ? 'admin' : 'buyer';
            setRole(nextRole);
            if (nextRole === 'buyer') setCanManageUsers(false);
          }}
          className="h-10 rounded-md border border-zinc-300 bg-white px-3 font-normal"
        >
          <option value="buyer">Buyer</option>
          <option value="admin">Administrator</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={canManageUsers}
          disabled={role !== 'admin'}
          onChange={(event) => setCanManageUsers(event.target.checked)}
        />
        Manage users
      </label>
      <p className="text-xs text-zinc-500">
        Administrators can access Admin and Inventory. Manage users can invite,
        change access, and manage user setup.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !hasChanges}
          onClick={() => onSave(role, role === 'admin' && canManageUsers)}
          className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save permissions'}
        </button>
        {hasChanges && <span role="status" className="text-sm text-amber-700">Unsaved changes</span>}
      </div>
    </div>
  );
}

export type XeroStatus = {
  connected: boolean;
  tenantName: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  reconnectRequired: boolean;
  webhookConfigured: boolean;
  usage: {
    day_limit_remaining: number | null;
    minute_limit_remaining: number | null;
    rate_limit_problem: string | null;
    retry_after_seconds: number | null;
    next_allowed_at: string | null;
    source: string | null;
    observed_at: string;
  } | null;
  usageToday?: {
    callsObserved: number;
    bySource: Array<{ source: string | null; calls: number; lowest_remaining: number | null }>;
  };
};

type XeroContact = {
  id: string;
  name: string;
  email: string;
};

type XeroContactPerson = {
  email: string;
  name: string;
  kind: 'primary' | 'additional';
  includeInEmails: boolean;
};

async function fetchXeroContacts(email: string): Promise<XeroContact[]> {
  const response = await fetch(`/api/admin/xero/contacts?email=${encodeURIComponent(email)}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to search Xero contacts.');
  return data.contacts as XeroContact[];
}

export function XeroContactFields({
  email,
  initialContactId = '',
  autoLookup = false,
  emailInput,
  onContactSelected,
}: {
  email: string;
  initialContactId?: string;
  autoLookup?: boolean;
  emailInput?: ReactNode;
  onContactSelected?: (contact: XeroContact) => void;
}) {
  const [contactId, setContactId] = useState(initialContactId);
  const [contactName, setContactName] = useState('');
  const [contacts, setContacts] = useState<XeroContact[]>([]);
  const [lookupMessage, setLookupMessage] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [matchedEmail, setMatchedEmail] = useState(initialContactId ? email : '');
  const [lookupEmail, setLookupEmail] = useState('');

  const selectContact = useCallback((contact: XeroContact) => {
    setContactId(contact.id);
    setContactName(contact.name);
    setMatchedEmail(email);
    onContactSelected?.(contact);
  }, [email, onContactSelected]);

  async function findContacts() {
    if (!email) {
      setLookupMessage('Enter an email address first.');
      return;
    }
    setLookingUp(true);
    setLookupMessage('');
    setContacts([]);
    setLookupEmail(email);
    try {
      const matches = await fetchXeroContacts(email);
      setContacts(matches);
      if (matches.length === 1) {
        selectContact(matches[0]);
        setLookupMessage(`Matched ${matches[0].name}.`);
      } else if (matches.length === 0) {
        setLookupMessage('No exact Xero contact match. Enter the contact manually.');
      } else {
        setLookupMessage(`${matches.length} Xero contacts match this email. Select the correct contact.`);
      }
    } catch (err) {
      setLookupMessage(err instanceof Error ? err.message : 'Unable to search Xero contacts.');
    } finally {
      setLookingUp(false);
    }
  }

  useEffect(() => {
    if (!autoLookup || !email || initialContactId) return;
    let active = true;

    async function lookupAutomatically() {
      setLookingUp(true);
      setLookupMessage('');
      setLookupEmail(email);
      try {
        const matches = await fetchXeroContacts(email);
        if (!active) return;
        setContacts(matches);
        if (matches.length === 1) {
          selectContact(matches[0]);
          setLookupMessage(`Matched ${matches[0].name}.`);
        } else if (matches.length === 0) {
          setLookupMessage('No exact Xero contact match. Enter the contact manually.');
        } else {
          setLookupMessage(`${matches.length} Xero contacts match this email. Select the correct contact.`);
        }
      } catch (err) {
        if (active) setLookupMessage(err instanceof Error ? err.message : 'Unable to search Xero contacts.');
      } finally {
        if (active) setLookingUp(false);
      }
    }

    void lookupAutomatically();
    return () => {
      active = false;
    };
  }, [autoLookup, email, initialContactId, selectContact]);

  return (
    <div className="grid gap-3 lg:col-span-6">
      {emailInput && <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        {emailInput}
        <button type="button" onClick={findContacts} disabled={lookingUp} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60"><Search className="h-4 w-4" />{lookingUp ? 'Searching' : 'Find in Xero'}</button>
      </div>}
      {emailInput ? <input type="hidden" name="xeroContactId" value={matchedEmail === email ? contactId : ''} /> : <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-semibold">Xero Contact ID<input name="xeroContactId" value={contactId} onChange={(event) => { setContactId(event.target.value); setMatchedEmail(email); }} required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
        <button type="button" onClick={findContacts} disabled={lookingUp} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60"><Search className="h-4 w-4" />{lookingUp ? 'Searching' : 'Find in Xero'}</button>
      </div>}
      {lookupEmail === email && contacts.length > 1 && (
        <label className="grid gap-1 text-sm font-semibold">Matching Xero contacts
          <select
            defaultValue=""
            onChange={(event) => {
              const contact = contacts.find((candidate) => candidate.id === event.target.value);
              if (contact) selectContact(contact);
            }}
            className="h-10 rounded-md border border-zinc-300 bg-white px-3 font-normal"
          >
            <option value="" disabled>Select a contact</option>
            {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name} ({contact.email})</option>)}
          </select>
        </label>
      )}
      {emailInput && matchedEmail === email && contactName && <p className="text-sm text-zinc-700">Xero customer: <span className="font-semibold">{contactName}</span></p>}
      {lookupEmail === email && lookupMessage && <p className="text-sm text-zinc-500">{lookupMessage}</p>}
    </div>
  );
}

export function XeroPeopleAccess({
  organisationId,
  contactId,
  portalUsers,
  onEnabled,
}: {
  organisationId: number;
  contactId: string;
  portalUsers: AdminUser[];
  onEnabled: () => Promise<void>;
}) {
  const [people, setPeople] = useState<XeroContactPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyEmail, setBusyEmail] = useState('');
  const [message, setMessage] = useState('');
  const [invitedUserId, setInvitedUserId] = useState<number | null>(null);

  async function loadPeople() {
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(`/api/admin/xero/contact-people?contactId=${encodeURIComponent(contactId)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load people from Xero.');
      setPeople(data.people || []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load people from Xero.');
    } finally {
      setLoading(false);
    }
  }

  async function enablePerson(person: XeroContactPerson) {
    setBusyEmail(person.email);
    setMessage('');
    try {
      const response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enableXeroPerson', organisationId, email: person.email }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to enable this person.');
      setMessage(data.inviteSent ? `Setup email sent to ${person.email}.` : `Access enabled for ${person.email}; send setup email once Resend is available.`);
      await onEnabled();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to enable this person.');
    } finally {
      setBusyEmail('');
    }
  }

  async function invitePrimary() {
    setLoading(true); setMessage(''); setInvitedUserId(null);
    try {
      const peopleResponse = await fetch(`/api/admin/xero/contact-people?contactId=${encodeURIComponent(contactId)}`, { cache: 'no-store' });
      const peopleData = await peopleResponse.json();
      if (!peopleResponse.ok) throw new Error(peopleData.error || 'Unable to load the primary Xero contact.');
      const primary = (peopleData.people as XeroContactPerson[]).find((person) => person.kind === 'primary');
      if (!primary) throw new Error('This company has no primary Xero contact email. Add one in Xero first.');
      setPeople(peopleData.people);
      const existing = portalUsers.find((user) => user.email.toLowerCase() === primary.email.toLowerCase());
      if (existing && Number(existing.organisation_id) !== organisationId) throw new Error('The primary email belongs to another Store company. Review that user before inviting.');
      const response = existing
        ? await fetch('/api/admin/users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: existing.id }) })
        : await fetch('/api/admin/users', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'enableXeroPerson', organisationId, email: primary.email }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to invite the primary contact.');
      setInvitedUserId(Number(existing?.id ?? data.userId));
      setMessage(data.inviteSent === false ? `Buyer access was created for ${primary.email}, but the setup email could not be sent. Open the user and resend.` : `Setup invitation sent to ${primary.email}.`);
      await onEnabled().catch(() => setMessage((current) => `${current} Reload this page to refresh the user list.`));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to invite the primary contact.'); }
    finally { setLoading(false); }
  }

  const userByEmail = new Map(portalUsers.map((user) => [user.email.toLowerCase(), user]));
  return (
    <div className="mt-4 border-t border-zinc-100 pt-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <div>
          <h4 className="text-sm font-bold">Xero people</h4>
          <p className="text-xs text-zinc-500">Primary contact and additional people eligible for this company.</p>
        </div>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void invitePrimary()} disabled={loading} className="h-9 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-60">{loading ? 'Working…' : 'Invite primary contact'}</button><button type="button" onClick={loadPeople} disabled={loading} className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-semibold disabled:opacity-60">{loading ? 'Loading…' : people.length ? 'Refresh stored people' : 'Show eligible Xero people'}</button></div>
      </div>
      {people.length > 0 && <div className="mt-3 grid gap-2">
        {people.map((person) => {
          const portalUser = userByEmail.get(person.email);
          return <div key={person.email} className="flex flex-col justify-between gap-2 rounded-md border border-zinc-200 p-3 sm:flex-row sm:items-center">
            <div className="min-w-0"><p className="text-sm font-semibold">{person.name}</p><p className="truncate text-xs text-zinc-500">{person.email} · {person.kind === 'primary' ? 'Primary contact' : 'Additional person'}</p></div>
            {portalUser && Number(portalUser.organisation_id) !== Number(organisationId)
              ? <Link href={`/admin/users/${portalUser.id}`} className="text-xs font-semibold underline">Belongs to another company · Review user</Link>
              : portalUser?.is_active
              ? <span className="text-xs font-semibold text-green-700">Portal access enabled</span>
              : <button type="button" onClick={() => void enablePerson(person)} disabled={busyEmail === person.email} className="h-9 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-60">{busyEmail === person.email ? 'Enabling' : portalUser ? 'Re-enable access' : 'Enable access'}</button>}
          </div>;
        })}
      </div>}
      {message && <p className="mt-2 text-xs text-zinc-600">{message}{invitedUserId && <Link href={`/admin/users/${invitedUserId}`} className="ml-2 font-semibold underline">Open user</Link>}</p>}
    </div>
  );
}

export function XeroStatusPanel({
  xeroStatus,
  onRefresh,
}: {
  xeroStatus: XeroStatus;
  onRefresh: () => void;
}) {
  return (
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
          {xeroStatus.usage && (
            <p className="mt-2 text-xs font-medium">
              Xero API allowance: {xeroStatus.usage.day_limit_remaining ?? 'unknown'} calls left today; {xeroStatus.usage.minute_limit_remaining ?? 'unknown'} this minute. Last observed {new Date(xeroStatus.usage.observed_at).toLocaleString()} by {xeroStatus.usage.source || 'Xero sync'}.
              {xeroStatus.usage.next_allowed_at && ` Daily limit reached; next attempt after ${new Date(xeroStatus.usage.next_allowed_at).toLocaleString()}.`}
            </p>
          )}
          {xeroStatus.usageToday && (
            <p className="mt-2 text-xs font-medium">
              Today&apos;s observed Xero calls: {xeroStatus.usageToday.callsObserved || 0}
              {xeroStatus.usageToday.bySource.length
                ? ` (${xeroStatus.usageToday.bySource.map((entry) => `${entry.source || 'unknown'}: ${entry.calls}`).join('; ')})`
                : '. The source ledger will begin recording with the next Xero response.'}
            </p>
          )}
          <p className="mt-2 text-xs font-medium">
            Xero webhooks: {xeroStatus.webhookConfigured ? 'receiver key configured; queued events are processed every five minutes.' : 'receiver key is not configured. Reconciliation remains the fallback only.'}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={onRefresh} className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900">Refresh status</button>
          <a href="/api/admin/xero/connect" className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">Reconnect Xero</a>
        </div>
      </div>
    </div>
  );
}

export function InviteUserForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [role, setRole] = useState<'buyer' | 'admin'>('buyer');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch('/api/admin/companies', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Unable to load companies.');
        if (active) setCompanies(data.companies);
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'Unable to load companies.'); }
    }
    void load(); return () => { active = false; };
  }, []);
  async function createUser(form: HTMLFormElement) {
    setSubmitting(true); setError(''); setMessage('');
    const formData = new FormData(form);
    try {
      const response = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email: formData.get('email'), organisationId: Number(formData.get('organisationId')), role,
        canManageUsers: role === 'admin' && formData.get('canManageUsers') === 'on',
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to create user.');
      setMessage(data.inviteSent ? 'User created and account setup email sent.' : 'User created, but the setup email could not be sent.');
      form.reset(); await onCreated();
    } catch (error) { setError(error instanceof Error ? error.message : 'Failed to create user.'); }
    finally { setSubmitting(false); }
  }
  return <section><h2 className="text-lg font-bold">Invite a user</h2><p className="mb-4 text-sm text-zinc-500">Buyers join an existing company and use its pricing. <Link href="/admin/companies" className="underline">Create or manage companies</Link>.</p>
    {message && <p role="status" className="mb-3 text-sm text-green-800">{message}</p>}{error && <p role="alert" className="mb-3 text-sm text-red-800">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void createUser(event.currentTarget); }} className="grid gap-3 rounded-lg border border-zinc-200 bg-white p-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-semibold">Email<input name="email" type="email" required className="h-10 rounded border px-3 font-normal" /></label>
      <label className="grid gap-1 text-sm font-semibold">Access level<select value={role} onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'buyer')} className="h-10 rounded border bg-white px-3 font-normal"><option value="buyer">Buyer</option><option value="admin">Administrator</option></select></label>
      {role === 'buyer' ? <label className="grid gap-1 text-sm font-semibold sm:col-span-2">Company<select name="organisationId" required defaultValue="" className="h-10 rounded border bg-white px-3 font-normal"><option value="" disabled>Select a company</option>{companies.filter((company) => company.xero_contact_id).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select><span className="text-xs font-normal text-zinc-500">The email must be an eligible person on this company’s Xero contact.</span></label> : <label className="flex items-center gap-2 text-sm sm:col-span-2"><input name="canManageUsers" type="checkbox" />Manage users</label>}
      <div className="sm:col-span-2"><button disabled={submitting} className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60">{submitting ? 'Creating…' : 'Create and send setup email'}</button></div>
    </form>
  </section>;
}

export function UserEditorPage({ userId }: { userId: number }) {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [hasLoadedUsers, setHasLoadedUsers] = useState(false);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busyUserId, setBusyUserId] = useState<number | null>(null);

  async function loadUsers() {
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load users');
    setUsers(data.users || []);
    setHasLoadedUsers(true);
    setCanManageUsers(Boolean(data.canManageUsers));
  }

  useEffect(() => {
    let active = true;
    async function loadInitialData() {
      try {
        const usersResponse = await fetch('/api/admin/users', { cache: 'no-store' });
        const usersData = await usersResponse.json();
        if (!usersResponse.ok) throw new Error(usersData.error || 'Failed to load users');
        if (active) {
          setUsers(usersData.users || []);
          setHasLoadedUsers(true);
          setCanManageUsers(Boolean(usersData.canManageUsers));
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

  async function saveAccess(user: AdminUser, role: 'buyer' | 'admin', canManageUsers: boolean) {
    setBusyUserId(user.id);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setAccess', userId: user.id, role, canManageUsers }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to update access.');
      setMessage('User access updated.');
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update access.');
    } finally {
      setBusyUserId(null);
    }
  }

  async function updateEmail(user: AdminUser, formData: FormData) {
    setError('');
    setMessage('');
    const response = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateEmail', userId: user.id, email: formData.get('email') }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Failed to update email address');
      return;
    }
    if (data.signedOut) {
      router.replace('/login');
      return;
    }
    if (data.unchanged) {
      setMessage('Email address is unchanged.');
      return;
    }
    setMessage('Email updated and verified for this company. This user’s sessions and keys were revoked; colleagues are unaffected.');
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

  // PostgreSQL BIGINT values are serialized as strings by node-postgres.
  // Route parameters are numbers, so normalize before locating the editor target.
  const user = users.find((candidate) => Number(candidate.id) === userId);

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-3 border-b border-zinc-200 pb-4 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-medium text-zinc-500">User Admin</p>
            <h1 className="text-2xl font-bold">Edit user</h1>
          </div>
          <div className="flex flex-wrap items-center gap-4"><Link href="/admin/users" className="text-sm font-semibold text-zinc-700 underline">Back to users</Link><AdminMenu /></div>
        </div>

        {message && <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</div>}
        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

        {!user && !error && <p className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-500">{hasLoadedUsers ? 'This user no longer exists or you do not have access to view it.' : 'Loading user...'}</p>}
        {user && <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="mb-5 border-b border-zinc-100 pb-4">
            <h2 className="text-lg font-bold">{user.organisation_name}</h2>
            <p className="mt-1 text-sm text-zinc-500">{user.email} · {user.role}{user.role === 'admin' && user.can_manage_users ? ' · Manage users' : ''}</p>
            {user.role === 'buyer' && <p className="mt-1 text-sm text-zinc-500">Company discounts: Victron {user.discounts?.victron ?? 0}% · Renogy {user.discounts?.renogy ?? 0}%</p>}
          </div>

          {canManageUsers ? <>
            <UserCompany key={`company-${user.id}`} user={user} onChanged={loadUsers} />
            <form onSubmit={(event) => { event.preventDefault(); void updateEmail(user, new FormData(event.currentTarget)); }} className="mb-4 grid gap-3 border-t border-zinc-100 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="grid gap-1 text-sm font-semibold">Portal email
                <input name="email" type="email" defaultValue={user.email} required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" />
              </label>
              <button className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900">Update email</button>
              <p className="text-xs text-zinc-500 sm:col-span-2">The new email must be an eligible person on this company’s Xero contact. Changing it signs only this user out and revokes their API keys.</p>
            </form>
            <h3 className="text-sm font-bold">Permissions</h3>
            <UserAccessEditor key={`access-${user.id}-${user.role}-${user.can_manage_users}`} user={user} busy={busyUserId === user.id} onSave={(role, manager) => void saveAccess(user, role, manager)} />
            <ApiAccess user={user} onChanged={loadUsers} />
            <div className="mt-4 border-t border-zinc-100 pt-4"><h3 className="mb-2 text-sm font-bold">Account actions</h3><div className="flex flex-wrap gap-2">
              <button type="button" disabled={busyUserId === user.id} onClick={() => void sendSetupEmail(user)} className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60">{user.setup_expires_at ? 'Resend invite' : 'Send setup email'}</button>
              {(user.is_active || user.xero_person_kind === 'manual') && <button type="button" disabled={busyUserId === user.id} onClick={() => void setActive(user, !user.is_active)} className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60">{user.is_active ? 'Disable account' : 'Enable account'}</button>}
            </div></div>
          </> : <p className="text-sm text-zinc-500">You can view this account, but Manage users permission is required to make changes.</p>}
        </section>}
      </div>
    </main>
  );
}
