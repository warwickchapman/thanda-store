// Prices are ZAR excluding VAT. Quantity-break prices are never a pricing input.
const missing = value => value == null || (typeof value === 'string' && !value.trim());
const validCents = value => Number.isSafeInteger(value) && value > 0 && value < 1_000_000_000;
function cents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return validCents(amount) ? amount : null;
}
export function prices(product) {
  const cost = cents(product.price);
  if (product.currency !== 'ZAR' || !cost) return { error: 'An explicitly ZAR E-Order account price greater than zero and below R10,000,000, with at most two decimals, is required.' };
  const supplied = product.enduser_price_zar?.price;
  const calculated = missing(supplied);
  // Integer cents: dividing by 0.525 is multiplying by 40/21.
  const list = calculated ? Math.round(cost * 40 / 21) : cents(supplied);
  if (!validCents(list)) return { error: 'The E-Order list price must be greater than zero and below R10,000,000, with at most two decimals; review it before proceeding.' };
  return { cost: cost / 100, list: list / 100, sensible: Math.round(list * 3 / 5) / 100,
    listSource: calculated ? 'calculated' : 'eorder' };
}
