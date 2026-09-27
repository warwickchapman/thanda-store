import { localStockObservation } from './data-freshness.mjs';
import { victronSkuFamilyResolver } from './victron-sku-family.mjs';

export const REPLENISHMENT_POLICY = {
  salesWindows: { recent: 30, baseline: 90 },
  leadTimeDays: 5,
  safetyStockDays: 2,
  targetCoverDays: 14,
};

const stockSku = (value) => String(value || '').trim().toUpperCase().replace(/R$/, '');

export function replenishmentSourceKnown(source) {
  return Boolean(source?.observedAt && source.totalCount > 0 && source.missingCount === 0);
}

/**
 * A family is only known when every distinct stock article has an observation.
 * Hidden predecessors still contribute. Retail packaging is an alternate row
 * for the same article, not a second quantity to add to its base SKU.
 */
export function replenishmentFamilyStocks(products, successions, { checkedAt, staleAfterMinutes }) {
  const familyFor = victronSkuFamilyResolver(successions);
  const membersByFamily = new Map();
  const productsByArticle = new Map();
  const register = (sku) => {
    const article = stockSku(sku);
    const family = familyFor(article);
    const members = membersByFamily.get(family) || new Set();
    members.add(article);
    membersByFamily.set(family, members);
  };
  for (const product of products) {
    register(product.sku);
    const article = stockSku(product.sku);
    const rows = productsByArticle.get(article) || [];
    rows.push(product);
    productsByArticle.set(article, rows);
  }
  for (const succession of successions) {
    register(succession.predecessor_sku);
    register(succession.successor_sku);
  }
  return new Map([...membersByFamily].map(([family, members]) => {
    let knownStock = 0;
    const missingSkus = [];
    const staleSkus = [];
    const observations = [];
    for (const article of members) {
      const rows = [...(productsByArticle.get(article) || [])].sort((left, right) =>
        Number(String(left.sku).toUpperCase().endsWith('R')) - Number(String(right.sku).toUpperCase().endsWith('R')));
      const observation = rows.map(localStockObservation).find((candidate) => candidate.quantity !== null
        && Date.parse(candidate.observedAt) <= Date.parse(checkedAt) + 300_000);
      if (!observation) {
        missingSkus.push(article);
        continue;
      }
      knownStock += observation.quantity;
      observations.push(observation.observedAt);
      if (Date.parse(checkedAt) - Date.parse(observation.observedAt) > staleAfterMinutes * 60_000) staleSkus.push(article);
    }
    return [family, {
      localStock: missingSkus.length ? null : knownStock,
      knownStock,
      missingSkus: missingSkus.sort(),
      staleSkus: staleSkus.sort(),
      observedAt: observations.sort()[0] || null,
    }];
  }));
}

/** Null inputs cannot be treated as zero demand, stock, deliveries or reservations. */
export function replenishmentRecommendation({ sales30, sales90, localStock, inbound, backorderCoverage, reserved, provisional, minimumStock }) {
  const policy = REPLENISHMENT_POLICY;
  const units = (value) => Math.max(0, Math.round(value));
  const dailyDemand = sales30 === null || sales90 === null ? null : Math.max(
    sales30 / policy.salesWindows.recent,
    sales90 / policy.salesWindows.baseline,
  );
  const reorderPoint = dailyDemand === null ? null : Math.max(
    units(dailyDemand * (policy.leadTimeDays + policy.safetyStockDays)), minimumStock,
  );
  const targetStock = dailyDemand === null ? null : Math.max(units(dailyDemand * policy.targetCoverDays), minimumStock);
  if ([localStock, inbound, backorderCoverage, reserved, targetStock].some((value) => value === null)) {
    return { dailyDemand, reorderPoint, targetStock, suggestedOrder: null, daysCover: null, status: 'review' };
  }
  const positionBeforeCart = localStock + inbound + backorderCoverage - reserved;
  const recommendationBeforeCart = units(targetStock - positionBeforeCart);
  const suggestedOrder = units(recommendationBeforeCart - provisional);
  const status = suggestedOrder === 0
    ? provisional > 0 && recommendationBeforeCart > 0 ? 'satisfied' : 'covered'
    : provisional > 0 ? 'in_cart' : positionBeforeCart <= reorderPoint ? 'order_now' : 'top_up';
  return {
    dailyDemand, reorderPoint, targetStock, suggestedOrder, status,
    daysCover: dailyDemand ? (positionBeforeCart + provisional) / dailyDemand : null,
  };
}
