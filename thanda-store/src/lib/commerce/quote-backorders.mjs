import { DATA_SOURCES, observationTime } from '../data-freshness.mjs';
import { loadSkuSuccessions, skuFamilyResolver } from '../sku-successions.mjs';
import { stockSku } from '../victron-sku-family.mjs';

// API budget: these bounded PostgreSQL reads add zero provider requests per
// quote, per day or on a cold cache. No sync schedules, retries or reserves
// change. Missing/old evidence falls back to availability on enquiry.
function currentSource(sourceId, observedAt, now) {
  const observed = observationTime(observedAt);
  const window = DATA_SOURCES.find(source => source.id === sourceId)?.staleAfterMinutes;
  return observed && Number.isFinite(window)
    && Date.parse(observed) <= now + 300_000
    && now - Date.parse(observed) <= window * 60_000 ? observed : null;
}

function orderObservation(state, now) {
  if (!state || state.last_error) return null;
  const completed = observationTime(state.last_completed_at);
  const succeeded = observationTime(state.last_successful_sync_at);
  const started = observationTime(state.last_started_at);
  // The E-Order importer predates data_sync_status. Its direct provider fetch
  // completes at this source observation time. A later failed/running import
  // must not make the retained snapshot look successful.
  if (!completed || completed !== succeeded || (started && started > completed)) return null;
  return currentSource('victron-orders', succeeded, now);
}

/** Return only dated, uncommitted supply for the actual fulfilled articles. */
export async function quoteBackorders(db, products, now = new Date()) {
  const checkedAt = new Date(now).getTime();
  if (!Number.isFinite(checkedAt)) return [];
  const counts = new Map();
  for (const product of products) {
    if (String(product.supplier).toLowerCase() !== 'victron') continue;
    const article = stockSku(product.sku);
    if (article) counts.set(article, (counts.get(article) || 0) + 1);
  }
  // A repeated article (including retail packaging) would share one supply
  // balance across quote lines. Withhold that estimate instead of allocating
  // the same planned units twice.
  const articles = [...counts].filter(([, count]) => count === 1).map(([sku]) => sku);
  if (!articles.length) return [];

  try {
    const [quoteState, orderState] = await Promise.all([
      db.query(`SELECT last_status, source_observed_at, last_error
        FROM data_sync_status WHERE source_id = 'accepted-quotes'`),
      db.query(`SELECT last_started_at, last_completed_at, last_successful_sync_at, last_error
        FROM victron_order_sync_state WHERE id = true`),
    ]);
    const quotes = quoteState.rows[0];
    const observedAt = orderObservation(orderState.rows[0], checkedAt);
    if (!observedAt || quotes?.last_status !== 'success' || quotes.last_error
      || !currentSource('accepted-quotes', quotes.source_observed_at, checkedAt)) return [];

    const [successions, backorders, inbound, reservations] = await Promise.all([
      loadSkuSuccessions(db),
      db.query(`SELECT line.order_number, line.sku, line.quantity,
          line.planned_for::text AS planned_for, orders.reference,
          ignored.sku AS ignored_sku
        FROM victron_provisional_backorder_order_lines line
        JOIN victron_provisional_backorders orders ON orders.order_number = line.order_number
        LEFT JOIN victron_backorder_ignored_lines ignored
          ON ignored.order_number = line.order_number AND ignored.sku = line.sku
        WHERE REGEXP_REPLACE(UPPER(TRIM(line.sku)), 'R$', '') = ANY($1::text[])
          AND line.planned_for IS NOT NULL`, [articles]),
      db.query(`SELECT orders.supplier_order_number AS order_number, line.sku
        FROM supplier_inbound_order_lines line
        JOIN supplier_inbound_orders orders ON orders.id = line.inbound_order_id
        WHERE orders.supplier = 'victron' AND orders.source = 'inbound'
          AND orders.status = 'open' AND line.is_stock_item = true
          AND line.ordered_quantity > line.received_quantity`),
      db.query(`SELECT line.sku, line.quantity
        FROM xero_accepted_quote_lines line
        JOIN xero_accepted_quotes quote ON quote.quote_id = line.quote_id
        WHERE quote.reservation_eligible = true`),
      // The shared resolver tolerates an absent succession table during
      // initial deployment. Estimates cannot: an unknown map could miss a
      // predecessor reservation, so explicitly require its schema here.
      db.query('SELECT 1 FROM victron_sku_successions LIMIT 0'),
    ]);
    const familyFor = skuFamilyResolver(successions);
    const family = sku => familyFor('victron', sku);
    // Existing accepted quotes may already consume any member's supply. This
    // deliberately withholds the whole family rather than inventing an
    // allocation between owned stock, inbound goods and future backorders.
    const reserved = new Set(reservations.rows.filter(row => Number(row.quantity) > 0).map(row => family(row.sku)));
    const overlapping = new Set(inbound.rows.map(row => `${row.order_number}:${family(row.sku)}`));
    const orderArticleCounts = new Map();
    for (const row of backorders.rows) {
      const key = `${row.order_number}:${stockSku(row.sku)}`;
      orderArticleCounts.set(key, (orderArticleCounts.get(key) || 0) + 1);
    }
    return backorders.rows.filter(row => {
      const article = stockSku(row.sku);
      const quantity = Number(row.quantity);
      const date = String(row.planned_for || '');
      const dateMs = Date.parse(`${date}T00:00:00Z`);
      return articles.includes(article) && !row.ignored_sku && !/rma/i.test(row.reference || '')
        && !reserved.has(family(article))
        // Any inbound overlap excludes this order/family's backorder balance;
        // its billed units cannot also establish later dated supply.
        && !overlapping.has(`${row.order_number}:${family(article)}`)
        && orderArticleCounts.get(`${row.order_number}:${article}`) === 1
        && Number.isSafeInteger(quantity) && quantity > 0
        && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(dateMs)
        && new Date(dateMs).toISOString().slice(0, 10) === date && dateMs > checkedAt;
    }).map(row => ({
      sku: stockSku(row.sku), quantity: Number(row.quantity), planned_for: row.planned_for,
      observed_at: observedAt, last_error: null,
    }));
  } catch (error) {
    // Optional caches can be absent during initial deployment. Connectivity,
    // permission and other real query failures must remain visible.
    if (error.code === '42P01') return [];
    throw error;
  }
}
