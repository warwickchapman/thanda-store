// Portal prices exclude VAT; Xero must receive an explicit standard sales tax code.
export function quoteLineItem(product, quantity) {
  return {
    ...(product.details?.xeroStockStatus && product.details.xeroStockStatus !== 'missing' ? { ItemCode: product.sku } : {}),
    Description: product.name,
    Quantity: quantity,
    UnitAmount: product.recommended_retail_ex_vat,
    DiscountRate: product.b2b_discount_percent,
    TaxType: 'OUTPUT3',
  };
}
