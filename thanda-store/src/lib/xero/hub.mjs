// Internal service client. The Hub is the only holder of Xero credentials.
function configuration() {
  const base = process.env.XERO_HUB_URL;
  const token = process.env.XERO_HUB_TOKEN;
  if (!base || !token) throw new Error('Xero Hub is not configured');
  return { base: base.replace(/\/$/, ''), token };
}

export async function hubRequest(path, init = {}) {
  const { base, token } = configuration();
  return fetch(`${base}/v1/thanda-solar/${path}`, {
    ...init, cache: 'no-store', signal: AbortSignal.timeout(40_000),
    headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token}` },
  });
}

export async function hubStatus() {
  const response = await hubRequest('status');
  if (!response.ok) throw new Error(`Xero Hub status unavailable (${response.status})`);
  return response.json();
}

export async function hubFetch(path, init = {}) {
  const url = new URL(String(path), 'http://hub.invalid');
  if (url.hostname !== 'hub.invalid') throw new Error('Only local accounting resource paths are allowed');
  const pieces = url.pathname.split('/').filter(Boolean);
  let target = `accounting${url.pathname}${url.search}`;
  const method = String(init.method || 'GET').toUpperCase();
  if (pieces.length === 3 && pieces[2] === 'pdf') {
    target = `documents/${pieces[0]}/${pieces[1]}/pdf`;
    init = { ...init, method: 'POST' };
  } else if (method !== 'GET') {
    if (method !== 'POST' || pieces[0] !== 'Quotes' || pieces.length > 2) throw new Error('Unsupported accounting command');
    target = `commands/quotes${pieces[1] ? `/${pieces[1]}` : ''}`;
  }
  const headers = new Headers(init.headers);
  // Synchronisation and allowance are Hub responsibilities, never passed through.
  headers.delete('If-Modified-Since');
  headers.delete('xero-tenant-id');
  headers.delete('Authorization');
  const response = await hubRequest(target, { ...init, headers });
  if (method === 'GET' && target.startsWith('accounting') && response.ok) {
    assertHubSnapshot(await response.clone().json());
  }
  return response;
}

// Each paged projection must stay on one stored revision or retain its old snapshot.
export function assertHubSnapshot(payload, previous) {
  const meta = payload?._hub;
  if (!meta?.complete || !meta.observed_at || !meta.snapshot) throw new Error('Xero Hub evidence is incomplete');
  if (previous !== undefined && previous !== meta.snapshot) throw new Error('Xero Hub collection changed during pagination; retry the complete read');
  return meta.snapshot;
}
