import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const TOKEN_URL = 'https://identity.xero.com/connect/token';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

export const XERO_SCOPES = [
  'offline_access',
  'accounting.settings.read',
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
