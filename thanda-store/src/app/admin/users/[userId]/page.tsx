import { UserEditorPage } from '@/components/admin/user-admin';

export default async function Page({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const parsedUserId = Number.parseInt(userId, 10);

  return <UserEditorPage userId={Number.isSafeInteger(parsedUserId) ? parsedUserId : -1} />;
}
