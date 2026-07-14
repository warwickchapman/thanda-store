import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import { currentUser } from '@/lib/auth/server';
import pool from '@/lib/db';
import { XERO_SCOPES, xeroConfig } from '@/lib/xero/oauth';

export const dynamic = 'force-dynamic';

function xeroStatusResponse(body: Record<string, unknown>, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...init?.headers,
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return xeroStatusResponse({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const config = xeroConfig();
    const raw = await fs.readFile(config.tokenFile, 'utf8');
    const token = JSON.parse(raw);
    const grantedScopes = String(token.scope || '').split(/\s+/).filter(Boolean);
    const requiredScopes = XERO_SCOPES.split(/\s+/).filter(Boolean);
    const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
    const usageResult = await pool.query(`
      SELECT day_limit_remaining, minute_limit_remaining, rate_limit_problem,
             retry_after_seconds, next_allowed_at, source, observed_at
      FROM xero_api_usage WHERE id = true
    `);

    return xeroStatusResponse({
      connected: Boolean(token.tenant_id && token.refresh_token),
      tenantName: token.tenant_name || null,
      tenantId: token.tenant_id || null,
      expiresAt: token.expires_at || null,
      grantedScopes,
      requiredScopes,
      missingScopes,
      reconnectRequired: missingScopes.length > 0,
      usage: usageResult.rows[0] || null,
    });
  } catch {
    return xeroStatusResponse({
      connected: false,
      tenantName: null,
      tenantId: null,
      expiresAt: null,
      grantedScopes: [],
      requiredScopes: XERO_SCOPES.split(/\s+/).filter(Boolean),
      missingScopes: XERO_SCOPES.split(/\s+/).filter(Boolean),
      reconnectRequired: true,
      usage: null,
    });
  }
}
