import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { hubStatus } from '@/lib/xero/hub.mjs';
import { XERO_SCOPES } from '@/lib/xero/oauth';
export const dynamic = 'force-dynamic';
export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    const status = await hubStatus();
    const requiredScopes = XERO_SCOPES.split(/\s+/);
    const grantedScopes = status.scope.split(/\s+/);
    const missingScopes = requiredScopes.filter(scope => !grantedScopes.includes(scope));
    return NextResponse.json({
      connected: status.connected, tenantName: status.tenant_name, tenantId: status.tenant_id,
      expiresAt: status.expires_at, requiredScopes, grantedScopes, missingScopes,
      reconnectRequired: !status.connected || missingScopes.length > 0,
      webhookConfigured: Boolean(process.env.XERO_WEBHOOK_KEY), streams: status.streams,
      usage: status.budget ? { day_limit_remaining: status.budget.day_remaining,
        minute_limit_remaining: status.budget.minute_remaining, next_allowed_at: status.budget.blocked_until,
        rate_limit_problem: status.budget.limit_problem, observed_at: status.budget.observed_at, source: 'Xero Hub' } : null,
      usageToday: { callsObserved: status.by_source.reduce((sum, row) => sum + row.calls, 0), bySource: status.by_source },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Xero Hub is unavailable; existing portal data is retained.' }, { status: 503 });
  }
}
