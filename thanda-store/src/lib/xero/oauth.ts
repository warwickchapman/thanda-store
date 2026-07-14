import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';
const CONTACTS_URL = 'https://api.xero.com/api.xro/2.0/Contacts';
const ACCOUNTING_URL = 'https://api.xero.com/api.xro/2.0';
const EXCLUDED_ADDITIONAL_PERSON_EMAILS = new Set(['sales@thanda.solar']);

export const XERO_SCOPES = [
  'offline_access',
  'accounting.settings.read',
  'accounting.contacts.read',
  'accounting.invoices',
].join(' ');

export function xeroConfig() {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri = process.env.XERO_REDIRECT_URI || 'https://oc.sensible.co.za/api/xero/callback';
  const tokenFile = process.env.XERO_TOKEN_FILE || '/var/lib/thanda-store/xero-token.json';
  const connectSecret = process.env.XERO_CONNECT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('XERO_CLIENT_ID and XERO_CLIENT_SECRET are required');
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    tokenFile,
    connectSecret,
  };
}

export function buildAuthorizationUrl(state: string) {
  const config = xeroConfig();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: XERO_SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function createState() {
  return crypto.randomBytes(32).toString('hex');
}

export async function exchangeCodeForToken(code: string) {
  const config = xeroConfig();
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Xero token exchange failed: ${payload.error || response.status}`);
  }

  return payload as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
}

export async function fetchXeroConnections(accessToken: string) {
  const response = await fetch(CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Xero connections fetch failed: ${response.status}`);
  }
  return payload as Array<{
    id: string;
    tenantId: string;
    tenantName: string;
    tenantType: string;
  }>;
}

export async function saveXeroToken(data: unknown) {
  const config = xeroConfig();
  await fs.mkdir(path.dirname(config.tokenFile), { recursive: true });
  await fs.writeFile(config.tokenFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

type XeroToken = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
  tenant_id?: string;
  [key: string]: unknown;
};

export type XeroContactMatch = {
  id: string;
  name: string;
  email: string;
};

export type XeroContactPerson = {
  email: string;
  name: string;
  kind: 'primary' | 'additional';
  includeInEmails: boolean;
};

export type XeroContactDetails = {
  name: string;
  people: XeroContactPerson[];
};

type XeroContactsResponse = {
  Contacts?: Array<{
    ContactID?: string;
    ContactStatus?: string;
    Name?: string;
    EmailAddress?: string;
    FirstName?: string;
    LastName?: string;
    ContactPersons?: Array<{
      FirstName?: string;
      LastName?: string;
      EmailAddress?: string;
      IncludeInEmails?: boolean;
    }>;
  }>;
};

function personName(firstName: unknown, lastName: unknown, fallback: string) {
  return [String(firstName || '').trim(), String(lastName || '').trim()].filter(Boolean).join(' ') || fallback;
}

export async function getXeroContactDetails(contactId: string): Promise<XeroContactDetails> {
  const token = await accessTokenForRequest();
  if (!token.access_token || !token.tenant_id) throw new Error('Xero connection is incomplete');

  const response = await fetch(`${CONTACTS_URL}/${encodeURIComponent(contactId)}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'xero-tenant-id': token.tenant_id,
      Accept: 'application/json',
    },
  });
  const payload = await response.json() as XeroContactsResponse;
  if (!response.ok) throw new Error(`Xero contact fetch failed: ${response.status}`);
  const contact = payload.Contacts?.[0];
  if (!contact || String(contact.ContactStatus || '').toUpperCase() === 'ARCHIVED') {
    throw new Error('Xero contact was not found or is archived');
  }

  const primaryEmail = String(contact.EmailAddress || '').trim().toLowerCase();
  const primary = primaryEmail
    ? [{
      email: primaryEmail,
      name: personName(contact.FirstName, contact.LastName, String(contact.Name || primaryEmail)),
      kind: 'primary' as const,
      includeInEmails: true,
    }]
    : [];
  const additional = (contact.ContactPersons || [])
    .map((person) => {
      const email = String(person.EmailAddress || '').trim().toLowerCase();
      return {
        email,
        name: personName(person.FirstName, person.LastName, email),
        kind: 'additional' as const,
        includeInEmails: person.IncludeInEmails === true,
      };
    })
    .filter((person) => person.email && person.email !== primaryEmail && !EXCLUDED_ADDITIONAL_PERSON_EMAILS.has(person.email));
  const name = String(contact.Name || '').trim();
  if (!name) throw new Error('Xero contact does not have a name');
  return { name, people: [...primary, ...additional] };
}

export async function getXeroContactPeople(contactId: string): Promise<XeroContactPerson[]> {
  return (await getXeroContactDetails(contactId)).people;
}

async function accessTokenForRequest() {
  const config = xeroConfig();
  const token = JSON.parse(await fs.readFile(config.tokenFile, 'utf8')) as XeroToken;
  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (token.access_token && token.tenant_id && expiresAt > Date.now() + 60_000) return token;
  if (!token.refresh_token) throw new Error('Xero token file does not contain a refresh token');

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }),
  });
  const refreshed = await response.json();
  if (!response.ok) throw new Error(`Xero token refresh failed: ${refreshed.error || response.status}`);

  const updated = {
    ...token,
    ...refreshed,
    expires_at: new Date(Date.now() + Number(refreshed.expires_in || 0) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  await saveXeroToken(updated);
  return updated as XeroToken;
}

export async function xeroAccountingFetch(pathname: string, init: RequestInit = {}) {
  const token = await accessTokenForRequest();
  if (!token.access_token || !token.tenant_id) throw new Error('Xero connection is incomplete');
  const response = await fetch(`${ACCOUNTING_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'xero-tenant-id': token.tenant_id,
      Accept: 'application/json',
      ...init.headers,
    },
  });
  return response;
}

export async function findXeroContactsByEmail(email: string): Promise<XeroContactMatch[]> {
  const token = await accessTokenForRequest();
  if (!token.access_token || !token.tenant_id) throw new Error('Xero connection is incomplete');

  const query = new URLSearchParams({
    where: `EmailAddress=="${email}"`,
    summaryOnly: 'true',
    page: '1',
    pageSize: '100',
  });
  const response = await fetch(`${CONTACTS_URL}?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'xero-tenant-id': token.tenant_id,
      Accept: 'application/json',
    },
  });
  const payload = await response.json() as XeroContactsResponse;
  if (!response.ok) throw new Error(`Xero contact lookup failed: ${response.status}`);

  return (Array.isArray(payload.Contacts) ? payload.Contacts : [])
    .filter((contact) => String(contact.ContactStatus || '').toUpperCase() !== 'ARCHIVED')
    .filter((contact) => String(contact.EmailAddress || '').trim().toLowerCase() === email.toLowerCase())
    .map((contact) => ({
      id: String(contact.ContactID),
      name: String(contact.Name || ''),
      email: String(contact.EmailAddress || ''),
    }))
    .filter((contact) => contact.id && contact.name);
}
