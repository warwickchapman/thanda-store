import crypto from 'node:crypto';
import sharp from 'sharp';
import { currentUser } from '@/lib/auth/server';
import { validCustomerViewOrigin as validAdminOrigin } from '@/lib/auth/impersonation-origin.mjs';
import pool from '@/lib/db';
import { ProductInputError, productIndex, saveStoreProduct, searchXeroProducts, storedXeroItems } from '@/lib/admin/store-products.mjs';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  if ((await currentUser())?.role !== 'admin') return Response.json({ error: 'Admin access required.' }, { status: 403 });
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('source') === 'store') {
      const result = await pool.query(`SELECT id,sku,name,category,image_url,details->>'description' AS description,
        details->>'recommendedRetailExVat' AS price, COALESCE((details->>'hidden')::boolean,false) AS hidden
        FROM products WHERE details->>'storeManaged'='true' ORDER BY name`);
      return Response.json({ products: result.rows }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const query = (params.get('q') || '').trim();
    if (query.length < 2 || query.length > 100) return Response.json({ error: 'Enter 2–100 characters to search.' }, { status: 400 });
    const [snapshot, index] = await Promise.all([storedXeroItems(), productIndex(pool)]);
    return Response.json({ ...searchXeroProducts(snapshot.items, index.products, index.successions, query), observedAt: snapshot.observedAt },
      { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'The saved product listing is unavailable. Try again shortly; no products were changed.' }, { status: 503 });
  }
}

async function boundedFormData(request: Request) {
  const maxBytes = 9 * 1024 * 1024;
  if (Number(request.headers.get('content-length')) > maxBytes) throw new ProductInputError('Upload a photo smaller than 8 MB.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ProductInputError('Product details are required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new ProductInputError('Upload a photo smaller than 8 MB.', 413); }
    chunks.push(value);
  }
  try { return await new Response(Buffer.concat(chunks), { headers: request.headers }).formData(); }
  catch { throw new ProductInputError('Invalid product form.'); }
}

async function save(request: Request, editing: boolean) {
  const user = await currentUser();
  if (user?.role !== 'admin') return Response.json({ error: 'Admin access required.' }, { status: 403 });
  if (!validAdminOrigin(request, { portalBaseUrl: process.env.PORTAL_BASE_URL, nodeEnv: process.env.NODE_ENV })) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  try {
    const form = await boundedFormData(request);
    const id = editing ? Number(form.get('id')) : null;
    if (editing && (!Number.isSafeInteger(id) || !id || id < 1)) throw new ProductInputError('Select a store product.');
    const input = {
      name: form.get('name'), description: form.get('description'), category: form.get('category'),
      price: form.get('price'), visible: form.get('visible') === 'true',
    };
    let image: Buffer | undefined;
    const photo = form.get('photo');
    if (photo instanceof File && photo.size) {
      if (photo.size > 8 * 1024 * 1024) throw new ProductInputError('Upload a photo smaller than 8 MB.', 413);
      try {
        const decoder = sharp(Buffer.from(await photo.arrayBuffer()), { limitInputPixels: 25_000_000, failOn: 'error' });
        const metadata = await decoder.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1) throw new Error('Unsupported photo');
        image = await decoder.rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
      } catch { throw new ProductInputError('Choose a valid JPG, PNG or WebP photo, up to 25 megapixels.'); }
    }
    const snapshot = editing ? null : await storedXeroItems();
    const item = snapshot?.items.find((candidate: { ItemID: string }) => candidate.ItemID === form.get('itemId'));
    const productId = await saveStoreProduct(pool, {
      id, item, observedAt: snapshot?.observedAt, input, image,
      imageRevision: image ? crypto.createHash('sha256').update(image).digest('hex').slice(0, 20) : undefined, actorId: user.id,
    });
    return Response.json({ id: productId, message: editing ? 'Product saved.' : 'Product added to the store.' }, { status: editing ? 200 : 201 });
  } catch (error) {
    if (error instanceof ProductInputError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: 'Unable to confirm the save. Check Added from Xero before trying again.' }, { status: 503 });
  }
}

export const POST = (request: Request) => save(request, false);
export const PATCH = (request: Request) => save(request, true);
