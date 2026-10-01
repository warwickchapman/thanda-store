import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/server';
import { StoreProductsAdmin } from '@/components/admin/store-products-admin';

export default async function ProductsPage() {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');
  return <StoreProductsAdmin />;
}
