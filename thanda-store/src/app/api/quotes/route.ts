import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import pool from '@/lib/db';
import { currentCatalogue } from '@/lib/catalogue';
import { currentUser } from '@/lib/auth/server';
import { xeroAccountingFetch } from '@/lib/xero/oauth';
import { isSupplierProductAvailable, resolveFulfilmentProduct } from '@/lib/victron-fulfilment';
import { sendQuoteRequestReceipt, sendSalesQuoteNotification } from '@/lib/email/resend';
import { customerQuoteStatus } from '@/lib/quote-settings';

function currentQuoteDate() {
  return new Date().toISOString().slice(0, 10);
}

function validationMessages(payload: unknown) {
  if (!payload || typeof payload !== 'object') return [];
  const elements = Array.isArray((payload as { Elements?: unknown }).Elements)
    ? (payload as { Elements: Array<{ ValidationErrors?: unknown }> }).Elements
    : [];
  return elements.flatMap((element) => Array.isArray(element.ValidationErrors)
    ? element.ValidationErrors
      .map((error) => typeof error === 'object' && error && 'Message' in error ? String(error.Message) : '')
      .filter(Boolean)
    : []);
}

export async function POST(request: Request) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    if (!user.xeroContactId) return NextResponse.json({ error: 'Your account must be linked to a Xero customer before a quote can be created.' }, { status: 409 });
    const body = await request.json().catch(() => null);
    const quoteReference = typeof body?.quoteReference === 'string' ? body.quoteReference.trim() : '';
    if (!quoteReference) return NextResponse.json({ error: 'A quote reference is required.' }, { status: 400 });
    if (quoteReference.length > 255) return NextResponse.json({ error: 'Quote reference must be 255 characters or fewer.' }, { status: 400 });

    const cart = await pool.query('SELECT product_id, quantity FROM portal_cart_lines WHERE user_id = $1 ORDER BY created_at ASC', [user.id]);
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
    // A retry of this unchanged checkout must not create a second Xero draft.
    const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify({
      userId: user.id,
      contactId: user.xeroContactId,
      quoteDate,
      quoteStatus,
      quoteReference,
      lineItems,
    })).digest('hex');
    const response = await xeroAccountingFetch('/Quotes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey, 'X-Hub-Actor': `portal-user:${user.id}`, 'X-Hub-Contact': user.xeroContactId,
      },
      body: JSON.stringify({ Quotes: [{
        Contact: { ContactID: user.xeroContactId },
        Date: quoteDate,
        Status: quoteStatus,
        LineAmountTypes: 'Exclusive',
        Reference: quoteReference,
        LineItems: lineItems,
      }] }),
    });
    const payload = await response.json();
    if (!response.ok) {
      console.error('Xero quote error:', {
        status: response.status,
        type: typeof payload === 'object' && payload ? (payload as { Type?: unknown }).Type : null,
        message: typeof payload === 'object' && payload ? (payload as { Message?: unknown }).Message : null,
        validationMessages: validationMessages(payload),
      });
      return NextResponse.json({ error: 'Xero could not create the draft quote. The cart has been kept unchanged.' }, { status: 502 });
    }
    const quote = payload.Quotes?.[0];
    await pool.query('DELETE FROM portal_cart_lines WHERE user_id = $1', [user.id]);
    let salesNotified = true;
    try {
      await sendSalesQuoteNotification({
        companyName: user.organisationName,
        buyerEmail: user.email,
        quoteNumber: quote?.QuoteNumber || null,
        quoteId: quote?.QuoteID || null,
        source: 'cart',
        quoteStatus,
        quoteReference,
      });
    } catch (error) {
      salesNotified = false;
      console.error('Sales quote notification failed:', error instanceof Error ? error.message : error);
    }
    let buyerAcknowledged = true;
    try {
      await sendQuoteRequestReceipt({
        to: user.email,
        companyName: user.organisationName,
        quoteNumber: quote?.QuoteNumber || null,
        quoteReference,
        items: lineItems.map((line) => ({ sku: line.ItemCode, description: line.Description, quantity: line.Quantity })),
      });
    } catch (error) {
      buyerAcknowledged = false;
      console.error('Buyer quote acknowledgement failed:', error instanceof Error ? error.message : error);
    }
    return NextResponse.json({
      quoteNumber: quote?.QuoteNumber || null,
      quoteId: quote?.QuoteID || null,
      quoteStatus,
      quoteReference,
      message: quoteStatus === 'DRAFT' ? 'Draft quote created in Xero.' : 'Quote created in Xero as sent.',
      salesNotified,
      buyerAcknowledged,
      cart: { lines: [], itemCount: 0, subtotalExVat: 0 },
    });
  } catch (error) {
    console.error('Quote creation error:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create draft quote' }, { status: 500 });
  }
}
