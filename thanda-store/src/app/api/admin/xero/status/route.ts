import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { currentUser } from '@/lib/auth/server';
import { XERO_SCOPES, xeroConfig } from '@/lib/xero/oauth';

export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const config = xeroConfig();
    const raw = await fs.readFile(config.tokenFile, 'utf8');
    const token = JSON.parse(raw);
    const grantedScopes = String(token.scope || '').split(/\s+/).filter(Boolean);
    const requiredScopes = XERO_SCOPES.split(/\s+/).filter(Boolean);
    const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));

    return NextResponse.json({
      connected: Boolean(token.tenant_id && token.refresh_token),
      tenantName: token.tenant_name || null,
      tenantId: token.tenant_id || null,
      expiresAt: token.expires_at || null,
      grantedScopes,
      requiredScopes,
      missingScopes,
      reconnectRequired: missingScopes.length > 0,
    });
  } catch {
    return NextResponse.json({
      connected: false,
      tenantName: null,
      tenantId: null,
      expiresAt: null,
      grantedScopes: [],
      requiredScopes: XERO_SCOPES.split(/\s+/).filter(Boolean),
      missingScopes: XERO_SCOPES.split(/\s+/).filter(Boolean),
      reconnectRequired: true,
    });
  }
}
