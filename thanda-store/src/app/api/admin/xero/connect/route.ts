import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
export async function GET() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  return NextResponse.redirect('https://cloud.sensible.co.za/admin/receivables/connect/thanda-solar');
}
