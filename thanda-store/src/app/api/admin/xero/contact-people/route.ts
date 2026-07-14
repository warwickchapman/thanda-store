import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { getXeroContactPeople } from '@/lib/xero/oauth';

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const contactId = new URL(request.url).searchParams.get('contactId')?.trim();
  if (!contactId) return NextResponse.json({ error: 'A Xero contact ID is required.' }, { status: 400 });

  try {
    return NextResponse.json({ people: await getXeroContactPeople(contactId) });
  } catch (error) {
    console.error('Xero contact people lookup failed:', error);
    return NextResponse.json({ error: 'Unable to load people from Xero.' }, { status: 502 });
  }
}
