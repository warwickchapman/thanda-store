'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

type AdminUser = {
  id: number;
  email: string;
  role: string;
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

type XeroStatus = {
  connected: boolean;
  tenantName: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  reconnectRequired: boolean;
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

function XeroContactFields({
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

  const selectContact = useCallback((contact: XeroContact) => {
    setContactId(contact.id);
    setContactName(contact.name);
    onContactSelected?.(contact);
  }, [onContactSelected]);

  async function findContacts() {
    if (!email) {
      setLookupMessage('Enter an email address first.');
      return;
    }
    setLookingUp(true);
    setLookupMessage('');
    setContacts([]);
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
      {emailInput ? <input type="hidden" name="xeroContactId" value={contactId} /> : <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-semibold">Xero Contact ID<input name="xeroContactId" value={contactId} onChange={(event) => setContactId(event.target.value)} required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
        <button type="button" onClick={findContacts} disabled={lookingUp} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60"><Search className="h-4 w-4" />{lookingUp ? 'Searching' : 'Find in Xero'}</button>
      </div>}
      {contacts.length > 1 && (
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
      {emailInput && contactName && <p className="text-sm text-zinc-700">Xero customer: <span className="font-semibold">{contactName}</span></p>}
      {lookupMessage && <p className="text-sm text-zinc-500">{lookupMessage}</p>}
    </div>
  );
}

function XeroPeopleAccess({
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

  const userByEmail = new Map(portalUsers.map((user) => [user.email.toLowerCase(), user]));
  return (
    <div className="mt-4 border-t border-zinc-100 pt-4">
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
        <div>
          <h4 className="text-sm font-bold">Xero people</h4>
          <p className="text-xs text-zinc-500">Primary contact and additional people eligible for this company.</p>
        </div>
        <button type="button" onClick={loadPeople} disabled={loading} className="h-9 rounded-md border border-zinc-300 px-3 text-sm font-semibold disabled:opacity-60">{loading ? 'Refreshing' : 'Refresh people'}</button>
      </div>
      {people.length > 0 && <div className="mt-3 grid gap-2">
        {people.map((person) => {
          const portalUser = userByEmail.get(person.email);
          return <div key={person.email} className="flex flex-col justify-between gap-2 rounded-md border border-zinc-200 p-3 sm:flex-row sm:items-center">
            <div className="min-w-0"><p className="text-sm font-semibold">{person.name}</p><p className="truncate text-xs text-zinc-500">{person.email} · {person.kind === 'primary' ? 'Primary contact' : 'Additional person'}</p></div>
            {portalUser?.is_active
              ? <span className="text-xs font-semibold text-green-700">Portal access enabled</span>
              : <button type="button" onClick={() => void enablePerson(person)} disabled={busyEmail === person.email} className="h-9 rounded-md bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-60">{busyEmail === person.email ? 'Enabling' : portalUser ? 'Re-enable access' : 'Enable access'}</button>}
          </div>;
        })}
      </div>}
      {message && <p className="mt-2 text-xs text-zinc-600">{message}</p>}
    </div>
  );
}

function XeroLinkEditor({
  user,
  onSave,
}: {
  user: AdminUser;
  onSave: (formData: FormData) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(!user.xero_contact_id);

  if (!editing && user.xero_contact_id) {
    return (
      <div className="flex flex-col justify-between gap-3 border-y border-zinc-100 py-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Xero contact linked</p>
          <p className="font-semibold text-zinc-900">{user.xero_contact_name}</p>
          <p className="text-xs text-zinc-500">{user.xero_contact_id}</p>
        </div>
        <button type="button" onClick={() => setEditing(true)} className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900">Edit Xero link</button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(new FormData(event.currentTarget)).then((saved) => {
          if (saved) setEditing(false);
        });
      }}
      className="grid gap-3 border-y border-zinc-100 py-4"
    >
      <XeroContactFields
        key={`${user.id}-${user.xero_contact_id || ''}`}
        email={user.email}
        initialContactId={user.xero_contact_id || ''}
        autoLookup={!user.xero_contact_id}
      />
      <div className="flex flex-wrap gap-2">
        <button className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">Save link</button>
        {user.xero_contact_id && <button type="button" onClick={() => setEditing(false)} className="h-10 rounded-md border border-zinc-300 px-4 text-sm font-semibold text-zinc-900">Cancel</button>}
      </div>
    </form>
  );
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [xeroStatus, setXeroStatus] = useState<XeroStatus | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteContact, setInviteContact] = useState<XeroContact | null>(null);

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
        email: formData.get('email'),
        xeroContactId: formData.get('xeroContactId'),
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

  async function saveLink(user: AdminUser, formData: FormData): Promise<boolean> {
    setError('');
    setMessage('');
    const response = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organisationId: user.organisation_id,
        xeroContactId: formData.get('xeroContactId'),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || 'Failed to save Xero link');
      return false;
    }
    setMessage('Xero contact link saved.');
    await loadUsers();
    return true;
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
      setMessage('Email address is unchanged. The Xero link was left in place.');
      return;
    }
    setMessage('Email updated. The Xero link was cleared; review the automatic match and save the new link.');
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createUser(new FormData(event.currentTarget));
            }}
            className="grid gap-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm lg:grid-cols-6"
          >
            <XeroContactFields
              key={`invite-${inviteEmail}`}
              email={inviteEmail}
              emailInput={<label className="grid gap-1 text-sm font-semibold">Email<input name="email" type="email" required value={inviteEmail} onChange={(event) => { setInviteEmail(event.target.value); setInviteContact(null); }} className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>}
              onContactSelected={setInviteContact}
            />
            {inviteContact && <>
              <label className="grid gap-1 text-sm font-semibold">Victron discount<input name="victronDiscount" type="number" min="0" max="40" step="0.01" defaultValue="30" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
              <label className="grid gap-1 text-sm font-semibold">Renogy discount<input name="renogyDiscount" type="number" min="0" max="40" step="0.01" defaultValue="30" required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" /></label>
              <div className="flex items-end lg:col-span-4"><button className="h-10 rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white">Create and send setup email</button></div>
            </>}
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
                    <p className="text-sm text-zinc-500">{user.email} · {user.role}</p>
                    <p className="mt-1 text-sm text-zinc-500">Discounts: Victron {user.discounts?.victron ?? 0}% · Renogy {user.discounts?.renogy ?? 0}%</p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${user.is_active ? 'bg-green-100 text-green-800' : 'bg-zinc-200 text-zinc-700'}`}>{user.is_active ? 'Active' : 'Disabled'}</span>
                    {user.setup_expires_at && <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">Setup pending</span>}
                  </div>
                </div>

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void updateEmail(user, new FormData(event.currentTarget));
                  }}
                  className="mb-4 grid gap-3 border-y border-zinc-100 py-4 sm:grid-cols-[1fr_auto] sm:items-end"
                >
                  <label className="grid gap-1 text-sm font-semibold">Portal email
                    <input name="email" type="email" defaultValue={user.email} required className="h-10 rounded-md border border-zinc-300 px-3 font-normal" />
                  </label>
                  <button className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900">Update email</button>
                  <p className="text-xs text-zinc-500 sm:col-span-2">Changing this email clears the organisation Xero link and signs this user out.</p>
                </form>

                <XeroLinkEditor user={user} onSave={(formData) => saveLink(user, formData)} />

                {user.xero_contact_id && users.find((candidate) => candidate.organisation_id === user.organisation_id)?.id === user.id && (
                  <XeroPeopleAccess
                    organisationId={user.organisation_id}
                    contactId={user.xero_contact_id}
                    portalUsers={users.filter((candidate) => candidate.organisation_id === user.organisation_id)}
                    onEnabled={loadUsers}
                  />
                )}

                <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-100 pt-4">
                  <button type="button" disabled={busyUserId === user.id} onClick={() => sendSetupEmail(user)} className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60">Send setup email</button>
                  {(user.is_active || user.xero_person_kind === 'manual') && <button type="button" disabled={busyUserId === user.id} onClick={() => setActive(user, !user.is_active)} className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-semibold text-zinc-900 disabled:opacity-60">{user.is_active ? 'Disable account' : 'Enable account'}</button>}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
