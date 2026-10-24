import { isCatalogueRestricted } from '../catalogue-access.mjs';
import { isStorefrontProduct } from '../catalogue-classification.mjs';
import { localStockObservation, supplierStockObservation } from '../data-freshness.mjs';
import { catalogueStockFamilies, withCatalogueFamilyStock } from '../catalogue-stock-families.mjs';
import { isSupersededForDiscovery } from '../catalogue-succession.mjs';
import { rankedFavouriteProducts } from '../favourite-products.mjs';
import { skuFamilyResolver } from '../sku-successions.mjs';

const supplierName = value => String(value || '').trim().toLowerCase();
const hidden = row => row.details?.hidden === true || row.details?.hidden === 'true';
const safePart = value => /^[A-Za-z0-9._-]+$/.test(String(value || ''));
/** @type {(row: { supplier: string, sku: string }) => boolean} */
const noThumbnail = () => false;

function imageUrl(row, hasThumbnail) {
  if (safePart(row.supplier) && safePart(row.sku) && hasThumbnail(row)) {
    return `/api/product-images/${encodeURIComponent(row.supplier)}/${encodeURIComponent(row.sku)}`;
  }
  try {
    const url = new URL(row.image_url);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search
      && ['victronenergy.com', 'www.victronenergy.com'].includes(url.hostname)) return url.href;
  } catch { /* A missing/unreviewed image is a useful empty state. */ }
  return null;
}

/** Deliberately independent of the cost-bearing authenticated catalogue object. */
export function selectPublicProducts(rows, successions, history, summaries = [], { now = Date.now(), hasThumbnail = noThumbnail } = {}) {
  const familyFor = skuFamilyResolver(successions);
  const visible = rows.filter(row => !hidden(row) && !isCatalogueRestricted(row) && isStorefrontProduct(row)
    && safePart(row.supplier) && safePart(row.sku) && Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0);
  const listings = catalogueStockFamilies(visible, successions)
    .filter(({ row }) => !isSupersededForDiscovery(row, visible, successions))
    .map(({ row, stock }) => withCatalogueFamilyStock({
      ...row,
      stock_on_hand: row.details?.cataloguePresent === false ? null : supplierStockObservation(row).quantity,
      details: { ...row.details, localStockOnHand: localStockObservation(row).quantity },
    }, stock));
  const originalById = new Map(visible.map(row => [row.id, row]));
  // Use Home's existing Popular calculation, including credits, replacement
  // families and stock-based representative choice. Editorial metadata never
  // decides eligibility, score or order. Unavailable products retain their rank.
  return rankedFavouriteProducts(history, listings, successions, false, now, 8, rows).map(ranked => {
    // Family stock is ranking input only. Public availability must use the
    // representative article's own observation, never an aggregated balance.
    const row = originalById.get(ranked.id);
    const supplier = supplierName(row.supplier);
    const summary = summaries.find(item => familyFor(item.supplier, item.sku) === familyFor(supplier, row.sku))?.summary;
    const observation = localStockObservation(row);
    const observedMs = Date.parse(observation.observedAt || '');
    const current = observation.quantity !== null && Number.isFinite(observedMs)
      && observedMs <= now + 300_000 && now - observedMs <= 120 * 60_000;
    // Construct every key. Never spread rows, details, history or prices.
    return {
      id: Number(row.id), supplier, sku: String(row.sku), name: String(row.name), category: String(row.category || ''),
      summary: String(summary || 'Ask the Thanda team for product advice, availability and a quote.').slice(0, 300), imageUrl: imageUrl(row, hasThumbnail),
      requestQuoteUrl: `https://store.thanda.solar/request-quote?product=${Number(row.id)}`,
      availability: { local: !current ? 'unknown' : observation.quantity > 0 ? 'in_stock' : 'out_of_stock', observedAt: observation.observedAt },
    };
  });
}
