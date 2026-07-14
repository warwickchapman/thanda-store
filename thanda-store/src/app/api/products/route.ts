import { spawn } from 'node:child_process';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { currentCatalogue } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';

const THUMBNAIL_RETRY_MS = 5 * 60 * 1000;
const thumbnailQueuedAt = new Map<number, number>();
export const runtime = 'nodejs';

function queueMissingThumbnails(products: Array<{ id: number; image_url?: string; thumbnail_url?: string }>) {
  const now = Date.now();
  const ids = products.filter((product) => product.image_url && !product.thumbnail_url)
    .filter((product) => now - (thumbnailQueuedAt.get(product.id) || 0) >= THUMBNAIL_RETRY_MS)
    .map((product) => product.id);
  if (!ids.length) return;
  ids.forEach((id) => thumbnailQueuedAt.set(id, now));
  try {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'generate-product-thumbnails.mjs'), ...ids.flatMap((id) => ['--id', String(id)])], {
      cwd: process.cwd(), detached: true, env: process.env, stdio: 'ignore',
    });
    child.once('error', () => ids.forEach((id) => thumbnailQueuedAt.delete(id)));
    child.unref();
  } catch { ids.forEach((id) => thumbnailQueuedAt.delete(id)); }
}

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const products = await currentCatalogue(user.discounts);
    queueMissingThumbnails(products);
    return NextResponse.json(products);
  } catch (error) {
    console.error('Products API error:', error);
    return NextResponse.json({ error: 'Failed to fetch products' }, { status: 500 });
  }
}
