import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ user: null }, { status: 401 });

  return NextResponse.json({
    user: {
      email: user.email,
      role: user.role,
      organisationName: user.organisationName,
      xeroContactId: user.xeroContactId,
      xeroContactName: user.xeroContactName,
      discounts: user.discounts,
    },
  });
}
