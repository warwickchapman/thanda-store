// Prices are ZAR excluding VAT. Quantity-break prices are never a pricing input.
const missing = value => value == null || (typeof value === 'string' && !value.trim());
const cents = value => !missing(value) && Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value) * 100) : null;
export function prices(product) {
  const cost = cents(product.price);
  if (product.currency !== 'ZAR' || !cost) return { error: 'A positive, explicitly ZAR E-Order account price is required.' };
  const supplied = product.enduser_price_zar?.price;
  const calculated = missing(supplied);
  // Integer cents: dividing by 0.525 is multiplying by 40/21.
  const list = calculated ? Math.round(cost * 40 / 21) : cents(supplied);
  if (!list) return { error: 'The supplied E-Order list price is invalid; review it before proceeding.' };
  return { cost: cost / 100, list: list / 100, sensible: Math.round(list * 0.6) / 100,
    listSource: calculated ? 'calculated' : 'eorder' };
}
