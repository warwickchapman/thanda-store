import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { isCatalogueRestricted, isProductVisibleTo } from '@/lib/catalogue-access.mjs';

export const runtime = 'nodejs';

const SAFE_PATH_PART = /^[A-Za-z0-9._-]+$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ supplier: string; sku: string }> },
) {
  const { supplier, sku } = await params;

  if (!SAFE_PATH_PART.test(supplier) || !SAFE_PATH_PART.test(sku)) {
    return new NextResponse(null, { status: 404 });
  }

  const restricted = isCatalogueRestricted({ supplier });
  if (restricted && !isProductVisibleTo({ supplier }, (await currentUser())?.email)) {
    return new NextResponse(null, { status: 404 });
  }

  const filePath = path.join(process.cwd(), 'public', 'product-images', supplier, `${sku}.webp`);

  try {
    const image = await fs.readFile(filePath);
    return new NextResponse(image, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': restricted ? 'private, no-store' : 'public, max-age=3600, stale-while-revalidate=86400',
        ...(restricted ? { Vary: 'Cookie' } : {}),
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
