import { currentUser } from '@/lib/auth/server';
import { catalogueExport } from '@/lib/commerce/catalogue-api';
export async function GET(request: Request) {
  const user=await currentUser();
  if (!user?.xeroContactId) return Response.json({error:'A linked customer account is required.'},{status:403});
  const url=new URL(request.url);url.searchParams.set('format','csv');
  return catalogueExport(new Request(url,{headers:request.headers}),user.xeroContactId);
}
