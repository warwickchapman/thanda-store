import { matchingXeroItem } from '../admin/store-products.mjs';
import { DATA_SOURCES, observationTime } from '../data-freshness.mjs';

const stockWindowMs = DATA_SOURCES.find(source => source.id === 'thanda').staleAfterMinutes * 60_000;

/**
 * Resolve accounting identities for all suppliers from one complete saved
 * Thanda Items snapshot. Null means evidence is unavailable; a Map entry of
 * null means reliable evidence contains no matching item. Neither is zero stock.
 * API budget: one local SELECT, zero Hub/Xero/supplier calls, no refresh or writes.
 * Product prices, stock, descriptions and existing requests remain untouched.
 */
export async function quoteItemIdentities(db, products, now = new Date()) {
  if (!products.length) return new Map();
  const checkedAt = new Date(now).getTime();
  if (!Number.isFinite(checkedAt)) return null;
  let result;
  try {
    result = await db.query(`SELECT company, observed_at, snapshot, items
      FROM thanda_inventory_evidence WHERE id = true`);
  } catch (error) {
    if (error.code === '42P01') return null;
    throw error;
  }
  if (result.rows.length !== 1) return null;
  const evidence = result.rows[0];
  const observed = observationTime(evidence.observed_at);
  if (evidence.company !== 'thanda-solar' || !observed
    || checkedAt - Date.parse(observed) > stockWindowMs || Date.parse(observed) > checkedAt + 300_000
    || typeof evidence.snapshot !== 'string' || !evidence.snapshot.trim() || evidence.snapshot.length > 1000
    || !Array.isArray(evidence.items) || evidence.items.length > 50_000) return null;

  const byCode = new Map();
  const byId = new Map();
  const seenIds = new Set();
  for (const item of evidence.items) {
    const code = typeof item?.Code === 'string' ? item.Code.trim() : '';
    const id = typeof item?.ItemID === 'string' ? item.ItemID.trim() : '';
    const key = code.toUpperCase();
    if (!code || code.length > 100 || !id || id.length > 100 || byCode.has(key) || seenIds.has(id.toLowerCase())) return null;
    const identity = { Code: code, ItemID: id };
    byCode.set(key, identity);
    byId.set(id, identity);
    seenIds.add(id.toLowerCase());
  }
  // Exact code matching also preserves Victron retail packaging and successor
  // articles as distinct accounting identities. Store-managed products retain
  // the shared resolver's additional ItemID and unchanged-code protections.
  return new Map(products.map(product => [Number(product.id), matchingXeroItem(product, byCode, byId)?.Code ?? null]));
}
