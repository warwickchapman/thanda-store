import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForToken,
  fetchXeroConnections,
  saveXeroToken,
  xeroConfig,
} from '@/lib/xero/oauth';

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get('state');
  const expectedState = request.cookies.get('xero_oauth_state')?.value;
  const code = request.nextUrl.searchParams.get('code');
  const error = request.nextUrl.searchParams.get('error');

  if (error) {
    return new NextResponse(`Xero authorization failed: ${error}`, { status: 400 });
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    return new NextResponse('Invalid Xero OAuth callback state', { status: 400 });
  }

  try {
    const config = xeroConfig();
    const token = await exchangeCodeForToken(code);
    const connections = await fetchXeroConnections(token.access_token);
    const preferredTenantId = process.env.XERO_TENANT_ID;
    const selectedTenant = preferredTenantId
      ? connections.find((connection) => connection.tenantId === preferredTenantId)
      : connections[0];

    if (!selectedTenant) {
      return new NextResponse('No Xero tenant is available for this authorization', { status: 400 });
    }

    await saveXeroToken({
      token_type: token.token_type,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      scope: token.scope,
      expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
      tenant_id: selectedTenant.tenantId,
      tenant_name: selectedTenant.tenantName,
      tenant_type: selectedTenant.tenantType,
      connections,
      updated_at: new Date().toISOString(),
      token_file: config.tokenFile,
    });

    const response = new NextResponse(
      `Xero connected to ${selectedTenant.tenantName}. You can close this tab.`,
      { status: 200 },
    );
    response.cookies.delete('xero_oauth_state');
    return response;
  } catch (callbackError) {
    console.error('Xero callback error:', callbackError);
    return new NextResponse('Xero callback failed', { status: 500 });
  }
}
