import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { quoteDraftsOnly, setQuoteDraftsOnly } from '@/lib/quote-settings';

async function requireAdmin() {
  const user = await currentUser();
  return user?.role === 'admin' ? user : null;
}

export async function GET() {
  if (!await requireAdmin()) return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
  return NextResponse.json({ draftsOnly: await quoteDraftsOnly() });
}

export async function PATCH(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: 'Admin access required.' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body.draftsOnly !== 'boolean') {
    return NextResponse.json({ error: 'draftsOnly must be a boolean.' }, { status: 400 });
  }
  return NextResponse.json({ draftsOnly: await setQuoteDraftsOnly(body.draftsOnly, user.id) });
}
