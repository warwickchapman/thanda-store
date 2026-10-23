const DAY_MS = 24 * 60 * 60_000;
const OUTCOMES = new Set(['success', 'missing', 'failed', 'rate-limited']);

function skuCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function timestamp(value) {
  const result = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(result) ? result : null;
}

function webUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function manufacturerUrl(value) {
  const address = webUrl(value);
  if (!address) return null;
  const url = new URL(address);
  return url.protocol === 'https:' && !url.port
    && (url.hostname === 'victronenergy.com' || url.hostname.endsWith('.victronenergy.com'))
    ? url.href : null;
}

function hasImage(product) {
  const value = typeof product.image_url === 'string' ? product.image_url.trim() : '';
  return Boolean(webUrl(value) || (value.startsWith('/') && !value.startsWith('//')));
}

function protectedMedia(product) {
  const details = product.details || {};
  return details.storeManaged === true
    || String(product.image_url || '').startsWith('/api/store-product-images/')
    || /(?:upload|editorial|manual|store-managed)/i.test(String(details.imageSource || ''));
}

function positiveQuantity(value) {
  return value !== null && value !== undefined && value !== '' && typeof value !== 'boolean'
    && Number.isFinite(Number(value)) && Number(value) > 0;
}

/** Local queue only: one article's media never substitutes for a successor. */
export function selectVictronMediaCandidates(products, states = new Map(), {
  limit = 5, now = Date.now(), refreshExisting = false, preferredSku = null,
} = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw new Error('Invalid Victron media batch size');
  const checkedAt = timestamp(now);
  if (checkedAt === null) throw new Error('Invalid Victron media queue time');
  const stateFor = sku => states instanceof Map ? states.get(sku) : states?.[sku];
  const preferred = skuCode(preferredSku);
  const seen = new Set();
  const priority = product => positiveQuantity(product.details?.localStockOnHand) ? 0
    : positiveQuantity(product.stock_on_hand) ? 1 : 2;
  return (Array.isArray(products) ? products : []).filter(product => {
    const sku = skuCode(product?.sku);
    if (!sku || product.supplier !== 'victron' || product.details?.hidden === true
      || protectedMedia(product) || (!refreshExisting && hasImage(product)) || seen.has(sku)) return false;
    seen.add(sku);
    const nextAttempt = timestamp(stateFor(sku)?.next_attempt_at);
    return nextAttempt === null || nextAttempt <= checkedAt;
  }).sort((left, right) => Number(skuCode(right.sku) === preferred) - Number(skuCode(left.sku) === preferred)
    || priority(left) - priority(right)
    || (Number(right.id) || 0) - (Number(left.id) || 0)
    || skuCode(left.sku).localeCompare(skuCode(right.sku))).slice(0, limit);
}

/** Omit absent/invalid fields so a sparse response cannot erase cached media. */
export function victronMediaFromExtended(payload, sku) {
  const code = skuCode(sku);
  if (!code || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || (payload.sku !== undefined && skuCode(payload.sku) !== code)
    || !payload.product_data || typeof payload.product_data !== 'object' || Array.isArray(payload.product_data)) {
    throw new Error('Invalid Victron extended product response');
  }
  const data = payload.product_data;
  const images = Array.isArray(data.main_images) ? data.main_images : [];
  const imageUrl = images.map(image => manufacturerUrl(image?.url)).find(Boolean) || manufacturerUrl(data.image);
  const details = {};
  if (typeof data.description === 'string' && data.description.trim()) details.description = data.description;
  if (Array.isArray(data.documents)) {
    const documents = data.documents.filter(document => document && typeof document === 'object'
      && !Array.isArray(document) && manufacturerUrl(document.url));
    if (documents.length) details.documents = documents;
  }
  if (Array.isArray(data.pms_technical_data)) {
    const technicalData = data.pms_technical_data.filter(item => item && typeof item === 'object'
      && !Array.isArray(item) && Object.keys(item).length);
    if (technicalData.length) details.technicalData = technicalData;
  } else if (data.pms_technical_data && typeof data.pms_technical_data === 'object'
    && Object.keys(data.pms_technical_data).length) {
    details.technicalData = data.pms_technical_data;
  }
  if (imageUrl) details.imageSource = 'victron-products-extended';
  return { ...(imageUrl ? { image_url: imageUrl } : {}), details };
}

export async function ensureVictronMediaSchema(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS victron_product_media_state (
    sku TEXT PRIMARY KEY,
    attempted_at TIMESTAMPTZ NOT NULL,
    next_attempt_at TIMESTAMPTZ,
    last_outcome TEXT NOT NULL CHECK (last_outcome IN ('success','missing','failed','rate-limited')),
    unsuccessful_attempts INTEGER NOT NULL DEFAULT 0 CHECK (unsuccessful_attempts >= 0)
  )`);
}

export async function loadVictronMediaState(db, skus) {
  const codes = [...new Set((Array.isArray(skus) ? skus : []).map(skuCode).filter(Boolean))];
  if (!codes.length) return new Map();
  const { rows } = await db.query(`SELECT sku, attempted_at, next_attempt_at, last_outcome,
    unsuccessful_attempts FROM victron_product_media_state WHERE sku=ANY($1::text[])`, [codes]);
  return new Map(rows.map(row => [skuCode(row.sku), row]));
}

/** Retries resume across runs. Provider cooldowns are additional hard stops. */
export async function recordVictronMediaAttempt(db, sku, { outcome, retryAt, now = Date.now() } = {}) {
  const code = skuCode(sku);
  const attemptedAt = timestamp(now);
  const retry = timestamp(retryAt);
  if (!code || !OUTCOMES.has(outcome) || attemptedAt === null
    || (outcome === 'rate-limited' && retry === null)) {
    throw new Error('Invalid Victron media attempt');
  }
  // SQL keeps each article's counter atomic. The catalogue job also has a
  // singleton lock; its shared HTTP client honours account-wide cooldowns.
  const { rows } = await db.query(`INSERT INTO victron_product_media_state
    (sku, attempted_at, next_attempt_at, last_outcome, unsuccessful_attempts)
    VALUES ($1,$2,CASE
      WHEN $3='success' THEN $2::timestamptz + INTERVAL '90 days'
      WHEN $3='rate-limited' THEN $4::timestamptz
      ELSE $2::timestamptz + $5::double precision * INTERVAL '1 millisecond' END,
      $3,CASE WHEN $3='success' THEN 0 ELSE 1 END)
    ON CONFLICT (sku) DO UPDATE SET attempted_at=EXCLUDED.attempted_at,
      last_outcome=EXCLUDED.last_outcome,
      unsuccessful_attempts=CASE WHEN $3='success' THEN 0
        ELSE LEAST(victron_product_media_state.unsuccessful_attempts + 1, 30) END,
      next_attempt_at=CASE
        WHEN $3='success' THEN $2::timestamptz + INTERVAL '90 days'
        WHEN $3='rate-limited' THEN $4::timestamptz
        ELSE $2::timestamptz + LEAST($6::double precision,
          $5::double precision * POWER(2,LEAST(victron_product_media_state.unsuccessful_attempts,4)))
          * INTERVAL '1 millisecond' END
    WHERE victron_product_media_state.attempted_at <= EXCLUDED.attempted_at
    RETURNING *`, [code, new Date(attemptedAt).toISOString(), outcome,
    retry === null ? null : new Date(retry).toISOString(),
    (outcome === 'missing' ? 7 : 1) * DAY_MS, (outcome === 'missing' ? 28 : 7) * DAY_MS]);
  return rows[0] || null;
}
