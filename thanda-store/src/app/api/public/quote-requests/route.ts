import pool from '@/lib/db';
import { publicFeaturedProducts } from '@/lib/commerce/public-storefront';
import { RfqError, ensurePublicRfqSchema, normalizeRfq, normalizeRfqInput, readRfqJson, recordPublicRfq, requireRfqOrigin, resumePublicRfq, rfqClientKey } from '@/lib/commerce/public-rfq.mjs';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    requireRfqOrigin(request);
    const body = await readRfqJson(request);
    const input = normalizeRfqInput(body, { checkTiming: false });
    await ensurePublicRfqSchema(pool);
    // Recover a lost response before consulting today's product selection.
    const saved = await resumePublicRfq(pool, input);
    if (saved) return Response.json(saved, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    const products = Array.isArray(body.lines) && body.lines.length === 0 ? [] : await publicFeaturedProducts();
    const enquiry = normalizeRfq(body, products);
    const receipt = await recordPublicRfq(pool, enquiry, rfqClientKey(request));
    return Response.json(receipt, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof RfqError ? error.status : 503;
    return Response.json({ error: error instanceof RfqError ? error.message : 'We could not save your enquiry. Please try again or contact sales@thanda.solar.' }, {
      status, headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '3600' } : {}) },
    });
  }
}
