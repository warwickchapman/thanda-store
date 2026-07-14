import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentCatalogue } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';

const LIMIT = 20;

export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const products = await currentCatalogue(user.discounts);
    const bySku = new Map(products.map((product) => [product.sku.toUpperCase(), product]));
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const start = cutoff.toISOString().slice(0, 10);

    const [mine, thanda] = await Promise.all([
      user.xeroContactId ? pool.query(`
        SELECT
          sku,
          COUNT(DISTINCT invoice_id)::int AS orders,
          MAX(invoice_date) AS last_ordered,
          COUNT(DISTINCT invoice_id) * 100
            + MAX(CASE
              WHEN invoice_date >= CURRENT_DATE - INTERVAL '90 days' THEN 20
              WHEN invoice_date >= CURRENT_DATE - INTERVAL '180 days' THEN 10
              ELSE 0
            END) AS rank_score
        FROM xero_sales_invoice_lines
        WHERE contact_id = $1 AND invoice_date >= $2::date
        GROUP BY sku
        ORDER BY rank_score DESC, MAX(invoice_date) DESC, SUM(quantity) DESC
        LIMIT $3
      `, [user.xeroContactId, start, LIMIT]) : Promise.resolve({ rows: [] }),
      pool.query(`
        SELECT sku, SUM(quantity) AS units, COUNT(DISTINCT invoice_id)::int AS orders, MAX(invoice_date) AS last_ordered
        FROM xero_sales_invoice_lines
        WHERE invoice_date >= $1::date
        GROUP BY sku
        ORDER BY SUM(quantity) DESC, COUNT(DISTINCT invoice_id) DESC, MAX(invoice_date) DESC
        LIMIT $2
      `, [start, LIMIT]),
    ]);
    const match = (rows: Array<{ sku: string }>) => rows.flatMap((row) => {
      const product = bySku.get(String(row.sku).toUpperCase());
      return product ? [product] : [];
    });
    return NextResponse.json({ mine: match(mine.rows), thanda: match(thanda.rows), windowStart: start });
  } catch (error) {
    console.error('Favourites API error:', error);
    return NextResponse.json({ error: 'Unable to load favourites' }, { status: 500 });
  }
}
