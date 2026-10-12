import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { validCustomerViewOrigin } from '@/lib/auth/impersonation-origin.mjs';
import { catalogueReviewUrl } from '@/lib/stock-review-view.mjs';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin' || user.impersonatedBy) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!validCustomerViewOrigin(request, { portalBaseUrl: process.env.PORTAL_BASE_URL, nodeEnv: process.env.NODE_ENV })) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || !['preview', 'create'].includes(body.action) || typeof body.sku !== 'string' || !/^[A-Z0-9-]{1,30}$/.test(body.sku)) return NextResponse.json({ error: 'Invalid item request' }, { status: 400 });
  // Old pages must use the current catalogue eligibility and audited command path.
  // Reject locally: no database lookup, Hub request or provider request is needed.
  return NextResponse.json({ error: 'Manage Victron products and review decisions in Victron catalogue review.',
    code: 'USE_CATALOGUE_REVIEW', reviewUrl: catalogueReviewUrl(body.sku) }, { status: 409 });
}
