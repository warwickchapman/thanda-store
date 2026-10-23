import { localStockObservation, observationTime, supplierStockObservation } from './data-freshness.mjs';
import { activeStockReview } from './stock-review.mjs';
import { stockSku } from './victron-sku-family.mjs';
import { archiveCompletionRecorded } from './victron-catalogue-review.mjs';

const FUTURE_ALLOWANCE_MS = 300_000;
export const CATALOGUE_STOCK_IMPORT_WAIT_MINUTES = 120;

// A retained quantity belongs to its old observation. Complete supplier
// catalogue absence is a product decision, never a fresh zero or failed feed.
export function confirmedCatalogueRemoval(product, now = new Date()) {
  const observedAt = observationTime(product.details?.catalogueObservedAt);
  return ['victron', 'renogy'].includes(product.supplier) && product.details?.cataloguePresent === false
    && observedAt !== null && Date.parse(observedAt) <= new Date(now).getTime() + FUTURE_ALLOWANCE_MS;
}

export function supplierStockScope(sourceId, products, now = new Date()) {
  const activeProducts = [];
  const lifecycleItems = [];
  for (const product of products.filter(row => row.supplier === sourceId)) {
    if (confirmedCatalogueRemoval(product, now)) {
      lifecycleItems.push({ sku: product.sku, name: product.name || '', observedAt: observationTime(product.details.catalogueObservedAt) });
    } else activeProducts.push(product);
  }
  return { activeProducts, lifecycleItems: lifecycleItems.sort((a, b) => a.sku.localeCompare(b.sku)) };
}

// Mirror the existing saved worklist, not all absent Store products. Panels
// never owned in Xero and already-recorded archives are informational removals.
export function supplierLifecycleActions(sourceId, lifecycleItems, review, completed, now = new Date()) {
  if (sourceId !== 'victron' || !lifecycleItems.length) return { lifecycleActionCount: 0 };
  const checkedAt = observationTime(review?.checked_at);
  const observedAt = observationTime(review?.observed_at);
  const current = new Date(now).getTime();
  if (!checkedAt || !observedAt || review?.error || !Array.isArray(review?.rows)
    || !review?.history || typeof review.history !== 'object' || Array.isArray(review.history)
    || [checkedAt, observedAt].some(time => Date.parse(time) > current + FUTURE_ALLOWANCE_MS
      || current - Date.parse(time) > 26 * 60 * 60_000)) {
    return { lifecycleActionCount: null,
      lifecycleReviewMessage: 'The saved catalogue comparison needs to be refreshed. Open catalogue review and choose Compare saved records. Recorded archive completions are kept; do not repeat them.' };
  }
  const absentArticles = new Set(lifecycleItems.map(item => stockSku(item.sku)));
  const pending = review.rows.filter(row => row.company === 'thanda-solar' && row.kind === 'archive'
    && absentArticles.has(stockSku(row.sku)) && !archiveCompletionRecorded(row, review.history, completed));
  return { lifecycleActionCount: pending.length };
}

/** Presentation only. Planning retains the unknown stock until the import. */
export function awaitingCatalogueStockImports(products, creations, { observedAt, complete, now = new Date() }) {
  const checkedAt = new Date(now).getTime();
  const savedAt = observationTime(observedAt);
  if (!complete || !savedAt) return [];
  const latest = new Map();
  for (const row of creations) {
    if (row.company !== 'thanda-solar') continue;
    const confirmedAt = observationTime(row.confirmed_at) || observationTime(row.created_at);
    if (!confirmedAt || Date.parse(confirmedAt) > checkedAt + FUTURE_ALLOWANCE_MS
      || checkedAt - Date.parse(confirmedAt) > CATALOGUE_STOCK_IMPORT_WAIT_MINUTES * 60_000
      || Date.parse(savedAt) >= Date.parse(confirmedAt)) continue;
    const article = stockSku(row.sku);
    if (!latest.has(article) || Date.parse(latest.get(article)) < Date.parse(confirmedAt)) latest.set(article, confirmedAt);
  }
  const historical = new Set(['Confirmed Xero creation', 'Previously seen or created in Xero',
    'Previously imported tracked Xero item', 'Previously tracked in Xero', 'Recorded sales or credit activity']);
  return products.filter(product => product.supplier === 'victron'
    && product.details?.xeroStockStatus === 'missing' && latest.has(stockSku(product.sku))
    && !(Number(product.details?.localStockOnHand) > 0)
    && (product.details?.inventoryRequirementReasons || []).every(reason => historical.has(reason)))
    .map(product => ({ sku: product.sku, name: product.name || '', createdAt: latest.get(stockSku(product.sku)) }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

// Stored evidence only: displaying remedies must never trigger a provider call.
export function stockHealthIssues(source, products, now = new Date()) {
  if (source.mode === 'manual') return [];
  return products.flatMap(product => {
    const local = source.id === 'thanda';
    const managedInventory = product.details?.storeManaged === true && product.details?.xeroStockStatus !== 'untracked';
    if (local ? !['victron', 'lora'].includes(product.supplier) && !managedInventory : product.supplier !== source.id) return [];
    if (local && product.supplier === 'victron' && product.details?.inventoryScope === 'catalogue') return [];
    if (local && product.supplier !== 'victron' && activeStockReview(product)) return [];
    if (!local && confirmedCatalogueRemoval(product, now)) return [];
    const observation = local ? localStockObservation(product) : supplierStockObservation(product);
    const details = product.details || {};
    let reason = '';
    let remedy = '';
    let kind = 'unknown-stock';
    let owner = 'maintainer';
    let actionLabel;
    let actionUrl;
    if (local && details.xeroStockStatus === 'missing') {
      kind = 'missing-record';
      owner = 'bookkeeper';
      reason = details.inventoryScope === 'unknown'
        ? 'Cannot confirm whether this article needs an inventory record'
        : 'Required inventory article is missing from the saved Xero item list';
      remedy = product.supplier === 'victron'
        ? `${details.inventoryRequirementReasons?.length ? details.inventoryRequirementReasons.join('; ') + '. ' : ''}Check the inventory record and article code with the bookkeeper. Use Victron catalogue review for a product addition if required. An exclusion, zero ZA supplier stock or 90-day ignore does not confirm zero Thanda stock. After a change, allow the normal stock import and check status again.`
        : 'Check the article code in Xero Products and services with the bookkeeper. Correct a code mismatch or configure the tracked item if you hold this stock. After correcting Xero, allow the next stock sync and check status again.';
      if (product.supplier === 'victron') {
        actionLabel = 'Open catalogue review';
        actionUrl = `/admin/victron-catalogue?company=thanda-solar&sku=${encodeURIComponent(product.sku)}`;
      }
    } else if (local && details.xeroStockStatus === 'untracked') {
      kind = 'untracked-record';
      owner = 'bookkeeper';
      reason = 'Xero item is not tracked as inventory';
      remedy = 'Ask the bookkeeper to review inventory tracking for this item in Xero. If this is a service or non-stock line, ask the Store maintainer to exclude it from stock planning. Repeated refreshes will not fix its configuration.';
    } else if (observation.quantity === null || !observation.observedAt) {
      reason = observation.observedAt ? 'Source did not provide a usable stock quantity' : 'No confirmed stock observation';
      remedy = local
        ? 'Check that the exact SKU is a tracked item with a quantity in Xero. If it is correct there, ask the Store maintainer to check the Hub Items snapshot and stock import.'
        : 'Check this SKU in the supplier portal. If it is available there, ask the Store maintainer to review catalogue matching and the supplier response. A missing observation does not confirm zero stock.';
    } else if (Date.parse(observation.observedAt) > new Date(now).getTime() + 300_000) {
      kind = 'invalid-time';
      reason = 'Observation time is in the future';
      remedy = 'Ask the Store maintainer to check the source timestamp and server clock.';
    } else if (new Date(now).getTime() - Date.parse(observation.observedAt) > source.staleAfterMinutes * 60_000) {
      kind = 'overdue-stock';
      reason = 'Stock observation is overdue';
      remedy = 'Follow the source recovery steps above. The saved quantity remains visible while the scheduled update recovers.';
    }
    return reason ? [{ sku: product.sku, name: product.name || '', reason, remedy, observedAt: observation.observedAt,
      kind, owner, ...(actionUrl ? { actionLabel, actionUrl } : {}) }] : [];
  }).sort((a, b) => a.sku.localeCompare(b.sku));
}

export function sourceRecovery(source) {
  const local = ['thanda', 'sales', 'accepted-quotes'].includes(source.id);
  const feedStatus = source.feedStatus || source.status;
  const actions = [];
  if (/HTTP 429/.test(source.lastError || '')) {
    actions.push('The provider has rate-limited requests. Allow the scheduled job to retry after the provider cooldown; do not repeatedly refresh the source. If the next scheduled run also fails, send the downloaded diagnostic report to the Store maintainer to review request frequency and the retry deadline.');
  } else if (/HTTP 40[13]/.test(source.lastError || '')) {
    actions.push(local
      ? 'Ask the Store maintainer to review the shared Xero Hub connection and permissions. Check Xero connection status in Settings.'
      : 'Ask the Store maintainer to renew the supplier credentials or session. A stock refresh cannot repair authentication.');
  } else if (feedStatus === 'error' || feedStatus === 'stale') {
    actions.push('Check again after the next scheduled update. If it still fails, download the diagnostic report for the Store maintainer to check the scheduled job and provider response. Saved quantities remain available.');
  }
  if (source.id === 'thanda') actions.push('The bookkeeper should check the listed Xero stock records and article codes. New catalogue additions may be waiting for the normal stock import; do not add them again. Thanda stock is imported every 30 minutes from the shared Hub. Sensible stock is separate and is not included here. Unknown balances remain unknown.');
  if (source.id === 'victron') actions.push('This is stock at Victron’s South African warehouse, separate from Thanda’s own Xero stock. Listed stock problems need a supplier-data check by the Store maintainer. Products confirmed removed from E-Order belong in catalogue review. Do not retry a successful import to resolve a removed product.');
  if (source.id === 'renogy') actions.push('This is Renogy supplier availability, separate from Thanda stock. The Store maintainer should check missing or overdue quantities against the supplier portal. A product confirmed absent from the current supplier list needs a catalogue decision; absence does not establish zero stock or end of life.');
  if (source.id === 'sales') actions.push('Sales and credit history is imported daily. If incomplete, ask the Store maintainer to check both invoice and credit-note snapshots in the shared Hub before retrying the import.');
  if (source.id === 'accepted-quotes') actions.push('Quote reservations are checked every 30 minutes. Use Check accepted quotes on Replenishment for an immediate check; if it fails, download the diagnostic report for the Store maintainer.');
  if (source.id === 'victron-orders') actions.push('Shipments and backorders are checked hourly. Review Inbound to confirm physical receipts; use its existing sync control when an immediate update is needed, unless the provider is rate-limiting requests.');
  return actions;
}
