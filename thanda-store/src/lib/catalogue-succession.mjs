import { productHasStock, replacementContext, successorSkus } from './sku-successions.mjs';

// Supersession changes discovery, not the recorded stock of either article.
// A stocked older Renogy article remains saleable under its own code. An
// unknown/empty predecessor gives way only to an explicitly linked, visible
// replacement that has actually been imported into the Store.
export function isSupersededForDiscovery(product, products, successions) {
  if (product.supplier.toLowerCase() !== 'renogy' || productHasStock(product)) return false;
  const successors = new Set(successorSkus(successions, product.supplier, product.sku));
  return products.some(candidate => candidate.supplier.toLowerCase() === 'renogy'
    && successors.has(candidate.sku.trim().toUpperCase()));
}

export function withSuccessionDetails(product, successions) {
  const context = replacementContext(successions, product.supplier, product.sku);
  const previousSkus = product.supplier.toLowerCase() === 'renogy'
    ? [...new Set(successions.filter(row => row.supplier === 'renogy').map(row => row.predecessor_sku))]
      .filter(sku => successorSkus(successions, 'renogy', sku).includes(product.sku.trim().toUpperCase()))
    : context.replaces;
  return { ...product, details: { ...product.details, ...context, previousSkus } };
}

export function catalogueProductMatchesQuery(product, query) {
  const search = String(query || '').trim().toLowerCase();
  if (!search) return true;
  return [product.sku, product.name, product.supplier, product.category, product.supplier_category,
    ...(Array.isArray(product.details?.previousSkus) ? product.details.previousSkus : [])]
    .some(value => String(value || '').toLowerCase().includes(search));
}
