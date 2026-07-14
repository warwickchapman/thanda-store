import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentCatalogue } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';
import { xeroAccountingFetch } from '@/lib/xero/oauth';

export async function POST() {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (!user.xeroContactId) return NextResponse.json({ error: 'Your account must be linked to a Xero customer before a quote can be created.' }, { status: 409 });

    const cart = await pool.query('SELECT product_id, quantity FROM portal_cart_lines WHERE user_id = $1 ORDER BY created_at ASC', [user.id]);
    if (!cart.rowCount) return NextResponse.json({ error: 'Your cart is empty.' }, { status: 400 });
    const catalogue = await currentCatalogue(user.discounts);
    const products = new Map(catalogue.map((product) => [product.id, product]));
    const lineItems = cart.rows.map((line) => {
      const product = products.get(Number(line.product_id));
      if (!product || product.your_price_ex_vat === null || product.recommended_retail_ex_vat === null) {
        throw new Error('A cart item no longer has a current price. Remove it or contact sales.');
      }
      return {
        ...(product.details.xeroStockStatus && product.details.xeroStockStatus !== 'missing' ? { ItemCode: product.sku } : {}),
        Description: product.name,
        Quantity: Number(line.quantity),
        UnitAmount: product.recommended_retail_ex_vat,
        DiscountRate: product.b2b_discount_percent,
      };
    });
    const response = await xeroAccountingFetch('/Quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Quotes: [{
        Contact: { ContactID: user.xeroContactId },
        Status: 'DRAFT',
        LineAmountTypes: 'Exclusive',
        Reference: `Thanda Store cart for ${user.email}`,
        LineItems: lineItems,
      }] }),
    });
    const payload = await response.json();
    if (!response.ok) {
      console.error('Xero quote error:', response.status, payload);
      return NextResponse.json({ error: 'Xero could not create the draft quote. The cart has been kept unchanged.' }, { status: 502 });
    }
    const quote = payload.Quotes?.[0];
    await pool.query('DELETE FROM portal_cart_lines WHERE user_id = $1', [user.id]);
    return NextResponse.json({
      quoteNumber: quote?.QuoteNumber || null,
      quoteId: quote?.QuoteID || null,
      message: 'Draft quote created in Xero.',
      cart: { lines: [], itemCount: 0, subtotalExVat: 0 },
    });
  } catch (error) {
    console.error('Quote creation error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create draft quote' }, { status: 500 });
  }
}
