import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/server';
import { currentCatalogue } from '@/lib/catalogue';
import pool from '@/lib/db';
import { isSupplierProductAvailable, resolveFulfilmentProduct } from '@/lib/victron-fulfilment';
import { auditAccountAction, customerDocument } from '@/lib/xero/customer-accounts';
import { xeroAccountingFetch } from '@/lib/xero/oauth';
import { sendQuoteRequestReceipt, sendSalesQuoteNotification } from '@/lib/email/resend';

type ProductLine = { productId: number; sku: string; name: string; quantity: number; unitPrice: number; discount: number };

function integerQuantity(value: unknown) {
  const quantity = Math.floor(Number(value));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

async function currentProducts(user: NonNullable<Awaited<ReturnType<typeof currentUser>>>) {
  return currentCatalogue(user.discounts);
}

async function sourceQuote(user: NonNullable<Awaited<ReturnType<typeof currentUser>>>, quoteId: string) {
  const cached = await customerDocument(user, 'quote', quoteId);
  if (!cached) throw new Error('Quote not found for your company.');
  const payload = cached.payload as { Contact?: { ContactID?: string }; QuoteNumber?: string; LineItems?: Array<{ ItemCode?: string; Quantity?: number }> };
  if (payload.Contact?.ContactID !== user.xeroContactId) throw new Error('Quote not found for your company.');
  return payload;
}

async function copyLines(user: NonNullable<Awaited<ReturnType<typeof currentUser>>>, quoteId: string) {
  const quote = await sourceQuote(user, quoteId);
  const catalogue = await currentProducts(user);
  const bySku = new Map(catalogue.map((product) => [product.sku.toUpperCase(), product]));
  const lines: ProductLine[] = [];
  const skipped: string[] = [];
  for (const line of quote.LineItems || []) {
    const sku = String(line.ItemCode || '').trim().toUpperCase();
    const quantity = integerQuantity(line.Quantity);
    let product = bySku.get(sku);
    if (!product && sku) {
      const successors = await pool.query<{ successor_sku: string }>(`
        WITH RECURSIVE replacements AS (
          SELECT successor_sku, ARRAY[UPPER(predecessor_sku)] AS path
          FROM victron_sku_successions WHERE UPPER(predecessor_sku) = $1
          UNION ALL
          SELECT next.successor_sku, replacements.path || UPPER(next.predecessor_sku)
          FROM replacements
          JOIN victron_sku_successions next ON UPPER(next.predecessor_sku) = UPPER(replacements.successor_sku)
          WHERE NOT UPPER(next.predecessor_sku) = ANY(replacements.path)
        ) SELECT successor_sku FROM replacements
      `, [sku]).catch((error: { code?: string }) => error.code === '42P01' ? { rows: [] } : Promise.reject(error));
      product = successors.rows.map((row) => bySku.get(row.successor_sku.toUpperCase())).find(Boolean);
    }
    if (!sku || !quantity || !product || product.your_price_ex_vat === null || product.recommended_retail_ex_vat === null) {
      if (sku) skipped.push(sku);
      continue;
    }
    lines.push({ productId: product.id, sku: product.sku, name: product.name, quantity, unitPrice: product.your_price_ex_vat, discount: product.b2b_discount_percent });
  }
  return { quoteNumber: String(quote.QuoteNumber || ''), lines, skipped };
}

export async function GET(_: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  try {
    const { quoteId } = await params;
    const result = await copyLines(user, quoteId);
    await auditAccountAction(user, 'quote_copy_opened', 'quote', quoteId, { quoteNumber: result.quoteNumber, skippedSkus: result.skipped });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to open quote copy.' }, { status: 502 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (!user.xeroContactId) return NextResponse.json({ error: 'Your account is not linked to a Xero customer.' }, { status: 409 });
  try {
    const { quoteId } = await params;
    const source = await sourceQuote(user, quoteId);
    const body = await request.json().catch(() => ({}));
    const requestedLines = Array.isArray(body.lines) ? body.lines : [];
    if (!requestedLines.length) return NextResponse.json({ error: 'Add at least one product.' }, { status: 400 });
    const catalogue = await currentProducts(user);
    const products = new Map(catalogue.map((product) => [product.id, product]));
    const resolvedQuantities = new Map<number, number>();
    for (const line of requestedLines) {
      const productId = Number(line?.productId);
      const quantity = integerQuantity(line?.quantity);
      if (!productId || !quantity || !products.has(productId)) return NextResponse.json({ error: 'One or more selected products is no longer available.' }, { status: 400 });
      const fulfilment = await resolveFulfilmentProduct(productId);
      if (!fulfilment || !isSupplierProductAvailable(fulfilment)) return NextResponse.json({ error: 'One or more selected products is not currently available.' }, { status: 409 });
      resolvedQuantities.set(fulfilment.id, (resolvedQuantities.get(fulfilment.id) || 0) + quantity);
    }
    const lineItems = Array.from(resolvedQuantities.entries()).map(([productId, quantity]) => {
      const product = products.get(productId);
      if (!product || product.your_price_ex_vat === null || product.recommended_retail_ex_vat === null) throw new Error('A selected product no longer has a current price.');
      return {
        ...(product.details.xeroStockStatus && product.details.xeroStockStatus !== 'missing' ? { ItemCode: product.sku } : {}),
        Description: product.name, Quantity: quantity, UnitAmount: product.recommended_retail_ex_vat, DiscountRate: product.b2b_discount_percent,
      };
    });
    const date = new Date().toISOString().slice(0, 10);
    const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify({ userId: user.id, contactId: user.xeroContactId, sourceQuoteId: quoteId, date, lineItems })).digest('hex');
    const response = await xeroAccountingFetch('/Quotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ Quotes: [{ Contact: { ContactID: user.xeroContactId }, Date: date, Status: 'DRAFT', LineAmountTypes: 'Exclusive', Reference: `Reorder from ${source.QuoteNumber || 'quote'}`, LineItems: lineItems }] }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return NextResponse.json({ error: 'Xero could not create the copied draft quote.' }, { status: 502 });
    const quote = Array.isArray(payload.Quotes) ? payload.Quotes[0] as { QuoteID?: string; QuoteNumber?: string } : null;
    await auditAccountAction(user, 'quote_copied_to_draft', 'quote', quoteId, { sourceQuoteNumber: source.QuoteNumber || null, newQuoteId: quote?.QuoteID || null, newQuoteNumber: quote?.QuoteNumber || null, lineCount: lineItems.length });
    let salesNotified = true;
    try {
      await sendSalesQuoteNotification({
        companyName: user.organisationName,
        buyerEmail: user.email,
        quoteNumber: quote?.QuoteNumber || null,
        quoteId: quote?.QuoteID || null,
        source: 'quote_copy',
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
        items: lineItems.map((line) => ({ sku: line.ItemCode, description: line.Description, quantity: line.Quantity })),
      });
    } catch (error) {
      buyerAcknowledged = false;
      console.error('Buyer quote acknowledgement failed:', error instanceof Error ? error.message : error);
    }
    return NextResponse.json({ quoteId: quote?.QuoteID || null, quoteNumber: quote?.QuoteNumber || null, salesNotified, buyerAcknowledged });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to create copied draft quote.' }, { status: 500 });
  }
}
