import { currentUser } from '@/lib/auth/server';
import { apiGuideMarkdown, openApiDocument } from '@/lib/commerce/api-documentation.mjs';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'Sign in required.' }, { status: 401, headers });
  if (!user.apiEnabled || !user.xeroContactId) {
    return Response.json({ error: 'API access must be enabled for your linked account.' }, { status: 403, headers });
  }
  const format = new URL(request.url).searchParams.get('format') || 'openapi';
  if (!['openapi', 'markdown'].includes(format)) return Response.json({ error: 'Use format=openapi or format=markdown.' }, { status: 400, headers });
  const markdown = format === 'markdown';
  return new Response(markdown ? apiGuideMarkdown() : JSON.stringify(openApiDocument, null, 2)+'\n', {
    headers: {
      ...headers,
      'Content-Type': markdown ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${markdown ? 'thanda-api-guide.md' : 'thanda-api-openapi.json'}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
