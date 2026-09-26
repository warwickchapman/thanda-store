import { NextResponse } from 'next/server';
import pool from '@/lib/db';
import { currentCatalogue } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';
import { xeroAccountingFetch } from '@/lib/xero/oauth';
import { isSupplierProductAvailable, resolveFulfilmentProduct } from '@/lib/victron-fulfilment';
import { recordQuoteRequest, resumeQuoteRequest, validRequestId } from '@/lib/commerce/quote-requests.mjs';
import { customerQuoteStatus } from '@/lib/quote-settings';

function currentQuoteDate() {
  return new Date().toISOString().slice(0, 10);
}

export async function POST(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (!user.xeroContactId) return NextResponse.json({ error: 'Your account must be linked to a Xero customer before a quote can be created.' }, { status: 409 });
    const body = await request.json().catch(() => null);
    const requestId = body?.requestId;
    if (!validRequestId(requestId)) return NextResponse.json({ error: 'A valid request ID is required. Reload the store and try again.' }, { status: 400 });
    const previous = await resumeQuoteRequest(pool,user,requestId,xeroAccountingFetch);
    if (previous) return NextResponse.json(previous);
    const quoteReference = typeof body?.quoteReference === 'string' ? body.quoteReference.trim() : '';
    if (!quoteReference) return NextResponse.json({ error: 'A quote reference is required.' }, { status: 400 });
    if (quoteReference.length > 255) return NextResponse.json({ error: 'Quote reference must be 255 characters or fewer.' }, { status: 400 });

    const cart = await pool.query('SELECT product_id, quantity, updated_at::text AS updated_at FROM portal_cart_lines WHERE user_id = $1 ORDER BY created_at ASC', [user.id]);
    if (!cart.rowCount) return NextResponse.json({ error: 'Your cart is empty.' }, { status: 400 });
    const catalogue = await currentCatalogue(user.discounts);
    const products = new Map(catalogue.map((product) => [product.id, product]));
    const resolvedQuantities = new Map<number, number>();
    for (const line of cart.rows) {
      const fulfilment = await resolveFulfilmentProduct(Number(line.product_id));
      if (!fulfilment) throw new Error('A cart item is no longer available. Remove it or contact sales.');
      if (!isSupplierProductAvailable(fulfilment)) {
        throw new Error(`${fulfilment.sku} is currently not available to order. The cart has been kept unchanged.`);
      }
      resolvedQuantities.set(fulfilment.id, (resolvedQuantities.get(fulfilment.id) || 0) + Number(line.quantity));
    }
    const lineItems = Array.from(resolvedQuantities.entries()).map(([productId, quantity]) => {
      const product = products.get(productId);
      if (!product || product.your_price_ex_vat === null || product.recommended_retail_ex_vat === null) {
        throw new Error('A cart item no longer has a current price. Remove it or contact sales.');
      }
      return {
        ...(product.details.xeroStockStatus && product.details.xeroStockStatus !== 'missing' ? { ItemCode: product.sku } : {}),
        Description: product.name,
        Quantity: quantity,
        UnitAmount: product.recommended_retail_ex_vat,
        DiscountRate: product.b2b_discount_percent,
      };
    });
    const quoteDate = currentQuoteDate();
    const quoteStatus = await customerQuoteStatus();
    await recordQuoteRequest(pool,user,requestId,{ Quotes: [{
      Contact:{ContactID:user.xeroContactId},Date:quoteDate,Status:quoteStatus,
      LineAmountTypes:'Exclusive',Reference:quoteReference,LineItems:lineItems,
    }] },{
      source:'cart',cart:cart.rows,companyName:user.organisationName,buyerEmail:user.email,
      salesEmail:process.env.SALES_QUOTE_NOTIFICATION_EMAIL || 'sales@thanda.solar',
      baseUrl:(process.env.PORTAL_BASE_URL || 'https://store.thanda.solar').replace(/\/$/,''),
    });
    return NextResponse.json(await resumeQuoteRequest(pool,user,requestId,xeroAccountingFetch));
  } catch (error) {
    console.error('Quote creation error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create draft quote' }, { status: 500 });
  }
}
