import { quoteAvailability, quoteNeedsBackorderEstimate } from './quote-availability.mjs';
import { quoteBackorders } from './quote-backorders.mjs';

// Portal prices exclude VAT; Xero must receive an explicit standard sales tax code.
export function quoteLineItem(product, quantity, { stock = product, now = new Date(), backorders = [] } = {}) {
  return {
    ...(product.details?.xeroStockStatus && product.details.xeroStockStatus !== 'missing' ? { ItemCode: product.sku } : {}),
    Description: `${product.name}\n\n${quoteAvailability(stock, quantity, { now, backorders })}`,
    Quantity: quantity,
    UnitAmount: product.recommended_retail_ex_vat,
    DiscountRate: product.b2b_discount_percent,
    TaxType: 'OUTPUT3',
  };
}

// Budget: only local PostgreSQL reads; zero additional Hub/Xero/supplier calls,
// including a cold cache. Existing quote limits, reserve, retries and durable
// request snapshots remain unchanged. Read evidence after article resolution;
// raw supplier/account metadata must never enter the public catalogue DTO.
export async function quoteLineItems(db, selections, now = new Date()) {
  if (!selections.length) return [];
  const result = await db.query(`
    SELECT id, sku, supplier, stock_on_hand, details
    FROM products WHERE id = ANY($1::bigint[])
  `, [selections.map(({ product }) => product.id)]);
  const stocks = new Map(result.rows.map(row => [Number(row.id), row]));
  const selectedStocks = selections.map(({ product }) => {
    const stock = stocks.get(Number(product.id));
    if (!stock || stock.sku !== product.sku || stock.supplier !== product.supplier) {
      throw new Error('A selected product has changed. Reload the store and try again.');
    }
    return stock;
  });
  const needsEstimate = selectedStocks.some((stock, index) => quoteNeedsBackorderEstimate(stock, selections[index].quantity, now));
  const backorders = needsEstimate ? await quoteBackorders(db, selectedStocks, now) : [];
  return selections.map(({ product, quantity }, index) => quoteLineItem(product, quantity, {
    stock: selectedStocks[index], now, backorders,
  }));
}
