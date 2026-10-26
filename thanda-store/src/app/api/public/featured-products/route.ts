import { publicFeaturedProducts } from '@/lib/commerce/public-storefront';

export const runtime = 'nodejs';

const allowedOrigins = new Set(['https://dev.thanda.solar', 'https://thanda.solar', 'https://www.thanda.solar', 'http://127.0.0.1:18774']);
function cors(request?: Request) {
  const origin = request?.headers.get('origin') || '';
  return { Vary: 'Origin', ...(allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}) };
}

export async function GET(request: Request) {
  try {
    return Response.json({ selection: 'popular', products: await publicFeaturedProducts() }, {
      headers: { ...cors(request), 'Cache-Control': 'public, max-age=60, s-maxage=60', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return Response.json({ error: 'Featured products are temporarily unavailable.' }, { status: 503, headers: { ...cors(request), 'Cache-Control': 'no-store' } });
  }
}

export async function OPTIONS(request: Request) {
  const headers = cors(request);
  return new Response(null, { status: 'Access-Control-Allow-Origin' in headers ? 204 : 403,
    headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
}
