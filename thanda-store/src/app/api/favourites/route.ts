import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentCatalogue } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';
import { loadSkuSuccessions } from '@/lib/sku-successions.mjs';
import { favouritesWindowStart, rankedFavouriteProducts } from '@/lib/favourite-products.mjs';

type InvoiceHistoryRow = {
  invoice_id: string;
  sku: string;
  invoice_date: string | Date;
  quantity: string | number;
};

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const products = await currentCatalogue(user.discounts, { userEmail: user.email });
    const start = favouritesWindowStart();

    const successions = await loadSkuSuccessions(pool);
    const [mine, thanda] = await Promise.all([
      user.xeroContactId ? pool.query(`
        SELECT invoice_id, sku, invoice_date, quantity
        FROM xero_sales_invoice_lines
        WHERE contact_id = $1 AND invoice_date >= $2::date
      `, [user.xeroContactId, start]) : Promise.resolve({ rows: [] as InvoiceHistoryRow[] }),
      pool.query(`
        SELECT invoice_id, sku, invoice_date, quantity
        FROM xero_sales_invoice_lines
        WHERE invoice_date >= $1::date
      `, [start]),
    ]);
    return NextResponse.json({
      mine: rankedFavouriteProducts(mine.rows, products, successions, true),
      thanda: rankedFavouriteProducts(thanda.rows, products, successions, false),
      windowStart: start,
    });
  } catch (error) {
    console.error('Favourites API error:', error);
    return NextResponse.json({ error: 'Unable to load favourites' }, { status: 500 });
  }
}
