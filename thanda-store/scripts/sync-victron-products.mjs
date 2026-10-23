#!/usr/bin/env node

import fs from 'node:fs';
import { saveCatalogueEvidence, ensureReviewSchema, readReviewDecisions } from '../src/lib/victron-catalogue-review.mjs';
import { loadVictronSyncContext, selectVictronSyncProducts } from '../src/lib/victron-sync-scope.mjs';
import { ensureVictronMediaSchema, loadVictronMediaState, selectVictronMediaCandidates, recordVictronMediaAttempt, victronMediaFromExtended } from '../src/lib/victron-media.mjs';
import { recordCatalogueLifecycle } from '../src/lib/victron-catalogue-lifecycle.mjs';
import { createVictronHttp, ensureVictronHttpSchema, nextCatalogueRun } from '../src/lib/victron-http.mjs';
import { startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';
import { observeVictronSupplierStock } from '../src/lib/data-freshness.mjs';
import { inventoryQuantity } from '../src/lib/inventory-scope.mjs';
import { prices } from '../src/lib/victron-pricing.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPool,
  ensureProductSchema,
  normalizeText,
  numberOrNull,
  upsertProduct,
} from './product-sync-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_ROOT = process.env.VICTRON_EORDER_API_ROOT || 'https://eorder.victronenergy.com/api/v1';
const API_KEY = process.env.VICTRON_EORDER_API_KEY;
const REQUEST_TIMEOUT_MS = Number(process.env.VICTRON_REQUEST_TIMEOUT_MS || 20000);
const PAGE_SIZE = Number(process.env.VICTRON_PAGE_SIZE || 250);
const PAGE_REQUEST_DELAY_MS = Number(process.env.VICTRON_PAGE_REQUEST_DELAY_MS || 1000);
const THANDA_DISCOUNT_FACTOR = Number(process.env.VICTRON_THANDA_DISCOUNT_FACTOR || 0.525);
const EXTENDED_REQUEST_DELAY_MS = Number(process.env.VICTRON_EXTENDED_REQUEST_DELAY_MS || 500);
const FETCH_EXTENDED = process.env.VICTRON_SYNC_EXTENDED === '1';
const MEDIA_BATCH_SIZE = Math.floor(Math.max(0, Math.min(5, Number(process.env.VICTRON_MEDIA_BATCH_SIZE ?? 5) || 0)));
const MEDIA_SKU_INDEX = process.argv.indexOf('--media-sku');
const PREFERRED_MEDIA_SKU = MEDIA_SKU_INDEX < 0 ? null : process.argv[MEDIA_SKU_INDEX + 1];
const RATE_LIMIT_CACHE_FILE = process.env.VICTRON_RATE_LIMIT_CACHE_FILE
  || path.resolve(__dirname, '../../.victron-rate-limit.json');

const pool = createPool();
const http = createVictronHttp({ pool, apiKey: API_KEY || '', apiRoot: API_ROOT,
  component: FETCH_EXTENDED ? 'catalogue-extended' : 'catalogue',
  trigger: process.argv.includes('--manual') ? 'manual' : 'scheduled', timeoutMs: REQUEST_TIMEOUT_MS, maxRequests: 20 });
let runClient;
let runLocked = false;

function readRateLimitCache() {
  try {
    return JSON.parse(fs.readFileSync(RATE_LIMIT_CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await http.request(url, {
      signal: controller.signal,
      headers: {
        Authorization: API_KEY,
        Accept: 'application/json',
        'User-Agent': 'ThandaStoreSync/1.0',
      },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const retryMessage = retryAfter ? ` retry after ${retryAfter}s` : '';
      const message = body?.detail || body?.message || text.slice(0, 200);
      throw new Error(`Victron HTTP ${response.status}:${retryMessage} ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPagedProducts(endpoint, pageSize = PAGE_SIZE) {
  const products = [];
  let expectedCount = null;
  let url = `${API_ROOT.replace(/\/$/, '')}/${endpoint}/?format=json&limit=${pageSize}`;
  while (url) {
    const page = await fetchJson(url);
    if (!Array.isArray(page) && (!page || !Array.isArray(page.results) || !Object.hasOwn(page, 'next') || (page.next !== null && (typeof page.next !== 'string' || !page.next)))) throw new Error('Incomplete catalogue response');
    if (!Array.isArray(page) && page.count != null) {
      if (expectedCount !== null && expectedCount !== Number(page.count)) throw new Error('Catalogue changed during pagination');
      expectedCount = Number(page.count);
    }
    const rows = Array.isArray(page) ? page : page.results;
    if (rows.some(row => !row || typeof row.sku !== 'string' || !row.sku.trim())) throw new Error('Invalid catalogue SKU');
    products.push(...rows);
    url = Array.isArray(page) ? '' : page.next;
    if (url && PAGE_REQUEST_DELAY_MS > 0) await sleep(PAGE_REQUEST_DELAY_MS);
  }
  if (!products.length || new Set(products.map(row => row.sku)).size !== products.length || (expectedCount !== null && expectedCount !== products.length)) throw new Error('Incomplete or duplicate catalogue; retained data unchanged');
  return products;
}

async function fetchExtendedProduct(sku) {
  return fetchJson(`${API_ROOT.replace(/\/$/, '')}/products-extended/${encodeURIComponent(sku)}/?format=json`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectImageUrl(product) {
  const productData = product.product_data && typeof product.product_data === 'object' && !Array.isArray(product.product_data) ? product.product_data : {};
  return victronMediaFromExtended({ sku: product.sku, product_data: productData }, product.sku).image_url || '';
}

function successorSkuFromDescription(description) {
  // Victron marks a replacement explicitly as: "If 0, order <SKU>". Do not
  // infer a succession from any other free-form product-description wording.
  const match = String(description || '').match(/\bif\s+0\s*,?\s*order\s+([A-Z0-9-]+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function buildProduct(product, existing, observedAt, inventoryItem, inventoryObservedAt) {
  const productData = product.product_data || {};
  const verifiedPrice = prices(product);
  const accountPrice = verifiedPrice.error ? numberOrNull(existing?.price) ?? 0 : verifiedPrice.cost;
  const apiRecommendedRetailExVat = numberOrNull(product.enduser_price_zar?.price);
  const recommendedRetailExVat = THANDA_DISCOUNT_FACTOR > 0
    ? Math.round((accountPrice / THANDA_DISCOUNT_FACTOR) * 100) / 100
    : apiRecommendedRetailExVat;
  const category = normalizeText(product.category || product.subcategory || productData.category, 'uncategorized');
  const name = normalizeText(product.description || productData.name, product.sku);
  const successorSku = successorSkuFromDescription(name);
  const imageUrl = selectImageUrl(product);
  const is120vAc = /(^|[^0-9])120V([^0-9]|$)/i.test(name);
  const hidden = existing?.details?.hidden === true || existing?.details?.hidden === 'true';
  const stock = observeVictronSupplierStock(product, observedAt);
  const supplierStock = stock.quantity;
  const details = {
    originalPrice: recommendedRetailExVat,
    supplierObservedAt: stock.observedAt,
    supplierStockStatus: stock.status,
    recommendedRetailExVat,
    recommendedRetailPriceVatMode: 'ex_vat',
    recommendedRetailSource: 'eorder_price_divided_by_thanda_discount_factor',
    apiRecommendedRetailExVat,
    thandaDiscountFactor: THANDA_DISCOUNT_FACTOR,
    thandaDiscountPercent: Math.round((1 - THANDA_DISCOUNT_FACTOR) * 10000) / 100,
    distributorPriceExVat: accountPrice,
    currency: product.currency || 'ZAR',
    gtin13: product.gtin13 || null,
    replacementSku: successorSku,
    apiReplacementSku: product.replacement_sku || null,
    subcategory: product.subcategory || null,
    categoryId: product.category_id || null,
    subcategoryId: product.subcategory_id || null,
    allStockByWarehouse: product.all_stock_by_warehouse || null,
    additionalStockQuantity: numberOrNull(product.additional_stock_quantity),
    priceBreakQty: numberOrNull(product.price_break_qty),
    priceBreakPrice: numberOrNull(product.price_break_price),
    minimumOrderQuantity: numberOrNull(product.minimum_order_quantity),
    productUrl: `https://eorder.victronenergy.com/api/v1/products/${encodeURIComponent(product.sku)}/`,
    hidden,
    is120vAc,
    productNotes: is120vAc ? ['Note: 120V AC'] : [],
    supplierStockLabel: 'Victron Warehouse ZA',
    // E-Order exposes current warehouse quantities but does not expose a
    // reliable inbound shipment/ETA field in the product response. Never
    // promise the normal lead time when South African stock is zero.
    supplierAvailability: supplierStock === null ? 'Availability unknown' : supplierStock > 0 ? 'Availability: 3-5 working days' : 'Out of stock / not available',
    supplierPriceStatus: verifiedPrice.error ? 'unknown' : 'known',
  };
  if (verifiedPrice.error) {
    for (const key of ['originalPrice', 'recommendedRetailExVat', 'recommendedRetailPriceVatMode', 'recommendedRetailSource', 'apiRecommendedRetailExVat',
      'thandaDiscountFactor', 'thandaDiscountPercent', 'distributorPriceExVat', 'currency']) delete details[key];
  }

  const protectedImage = existing?.details?.storeManaged === true
    || String(existing?.image_url || '').startsWith('/api/store-product-images/')
    || /upload|editorial|manual|store-managed/i.test(String(existing?.details?.imageSource || ''));
  if (!existing && inventoryItem?.IsTrackedAsInventory === true) {
    details.localStockOnHand = inventoryQuantity(inventoryItem.QuantityOnHand);
    details.xeroStockSyncedAt = new Date(inventoryObservedAt).toISOString();
    details.xeroStockStatus = 'tracked';
  }
  // Custom Store content and prices belong to the editor, while supplier
  // observations continue updating on the same schedule.
  if (existing?.details?.storeManaged === true) {
    return { ...existing, stock_on_hand: supplierStock ?? existing.stock_on_hand,
      details: { supplierObservedAt: stock.observedAt, supplierStockStatus: stock.status,
        allStockByWarehouse: product.all_stock_by_warehouse || null,
        supplierAvailability: details.supplierAvailability, supplierStockLabel: details.supplierStockLabel } };
  }

  return {
    sku: normalizeText(product.sku).toUpperCase(),
    supplier: 'victron',
    supplier_item_id: normalizeText(product.sku).toUpperCase(),
    name,
    category,
    price: accountPrice,
    image_url: protectedImage ? '' : imageUrl,
    stock_on_hand: supplierStock ?? 0,
    details,
  };
}

async function upsertSkuSuccession(client, product) {
  const predecessorSku = String(product.sku || '').trim().toUpperCase();
  const sourceDescription = normalizeText(product.description || product.product_data?.name);
  const successorSku = successorSkuFromDescription(sourceDescription);
  if (!predecessorSku || !successorSku || predecessorSku === successorSku) return false;

  await client.query(`
    INSERT INTO victron_sku_successions (predecessor_sku, successor_sku, source_description)
    VALUES ($1, $2, $3)
    ON CONFLICT (predecessor_sku) DO UPDATE SET
      successor_sku = EXCLUDED.successor_sku,
      source_description = EXCLUDED.source_description,
      last_seen_at = NOW()
  `, [predecessorSku, successorSku, sourceDescription]);
  return true;
}

async function refreshMissingMedia(stats, catalogue) {
  await ensureVictronMediaSchema(pool);
  const present = new Set(catalogue.map(row => String(row.sku).toUpperCase()));
  const stored = (await pool.query("SELECT id,supplier,sku,image_url,stock_on_hand,details FROM products WHERE supplier='victron'")).rows.filter(row => present.has(row.sku));
  const states = await loadVictronMediaState(pool, stored.map(row => row.sku));
  const candidates = selectVictronMediaCandidates(stored, states, {
    limit: MEDIA_BATCH_SIZE, refreshExisting: FETCH_EXTENDED, preferredSku: PREFERRED_MEDIA_SKU,
  });
  stats.media = { selected: candidates.length, attempted: 0, updated: 0, missing: [], failed: [], deferred: 0 };
  for (const candidate of candidates) {
    if (http.calls >= 20) { stats.media.deferred++; continue; }
    try {
      stats.media.attempted++;
      const patch = victronMediaFromExtended(await fetchExtendedProduct(candidate.sku), candidate.sku);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = (await client.query("SELECT id,supplier,sku,image_url,stock_on_hand,details FROM products WHERE supplier='victron' AND sku=$1 FOR UPDATE", [candidate.sku])).rows[0];
        // Recheck after downloading: an editor may have supplied a photo while
        // the request was in flight. Never replace that protected content.
        if (current && selectVictronMediaCandidates([current], new Map(), { limit: 1, refreshExisting: FETCH_EXTENDED }).length) {
          await client.query(`UPDATE products SET image_url=COALESCE(NULLIF($2,''),image_url),
            details=details || $3::jsonb,last_updated=NOW() WHERE supplier='victron' AND sku=$1`,
          [candidate.sku, patch.image_url || '', JSON.stringify(patch.details)]);
          if (patch.image_url) stats.media.updated++;
        }
        await recordVictronMediaAttempt(client, candidate.sku, { outcome: patch.image_url ? 'success' : 'missing' });
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      if (!patch.image_url) stats.media.missing.push(candidate.sku);
    } catch (error) {
      const retryAt = error.retryAt;
      await recordVictronMediaAttempt(pool, candidate.sku, { outcome: retryAt ? 'rate-limited' : 'failed', retryAt });
      stats.media.failed.push({ sku: candidate.sku, reason: retryAt ? 'Supplier cooldown' : 'Photo update failed; retained media preserved.' });
      if (retryAt) break;
    }
    if (EXTENDED_REQUEST_DELAY_MS > 0) await sleep(EXTENDED_REQUEST_DELAY_MS);
  }
}

async function main() {
  if (!API_KEY) throw new Error('VICTRON_EORDER_API_KEY is required.');
  await ensureVictronHttpSchema(pool);
  runClient = await pool.connect();
  runLocked = (await runClient.query("SELECT pg_try_advisory_lock(hashtext('victron-catalogue-sync')) AS locked")).rows[0]?.locked;
  if (!runLocked) return console.log('Catalogue sync already running; skipped.');
  // Migrate the old file cooldown without discarding an active supplier deadline.
  const legacy = Date.parse(readRateLimitCache()?.retryUntil || '');
  if (Number.isFinite(legacy) && legacy > Date.now())
    await pool.query(`INSERT INTO victron_http_state(account,scope,blocked_until) VALUES($1,'catalogue',$2)
      ON CONFLICT(account,scope) DO UPDATE SET blocked_until=GREATEST(victron_http_state.blocked_until,EXCLUDED.blocked_until)`, [http.account, new Date(legacy)]);
  const blocked = (await pool.query(`SELECT MAX(blocked_until) AS until FROM victron_http_state WHERE account=$1 AND scope IN ('catalogue','account')`, [http.account])).rows[0]?.until;
  const schedule = (await pool.query('SELECT * FROM victron_catalogue_schedule WHERE id=true')).rows[0];
  const manual = process.argv.includes('--manual');
  const due = manual ? new Date(schedule?.last_attempt_at || 0).getTime() + 15 * 60_000 : new Date(schedule?.next_scheduled_at || 0).getTime();
  if (new Date(blocked || 0).getTime() > Date.now() || due > Date.now()) {
    console.log(JSON.stringify({ skipped: true, reason: blocked && new Date(blocked).getTime() > Date.now() ? 'rate_limited' : 'not_due', retryAt: new Date(Math.max(due, new Date(blocked || 0).getTime())).toISOString() }));
    return;
  }
  await pool.query(`INSERT INTO victron_catalogue_schedule(id,last_attempt_at,next_scheduled_at) VALUES(true,NOW(),$1)
    ON CONFLICT(id) DO UPDATE SET last_attempt_at=NOW(),next_scheduled_at=EXCLUDED.next_scheduled_at`, [nextCatalogueRun()]);
  await pool.query("DELETE FROM victron_http_usage WHERE requested_at<NOW()-INTERVAL '30 days'");
  await startDataSync(pool, 'victron');

  const products = await fetchPagedProducts('products');
  const observedAt = new Date().toISOString();
  const explicitSuccessionProducts = products.filter((product) =>
    Boolean(successorSkuFromDescription(product.description || product.product_data?.name)),
  );
  const client = await pool.connect();
  const stats = {
    explicitSuccessions: explicitSuccessionProducts.length,
    apiProducts: products.length,
    matched: 0,
    added: [],
    discoveryDeferred: null,
    synced: 0,
    skuSuccessions: 0,
    missingFromApi: [],
    unverifiedPrices: [],
    extended: FETCH_EXTENDED,
  };

  try {
    await ensureProductSchema(client);
    await ensureReviewSchema(client);
    await client.query('BEGIN');
    const context = await loadVictronSyncContext(client);
    const selection = selectVictronSyncProducts(products, { ...context, decisions: await readReviewDecisions(client) });
    const existing = new Map(context.existing.map(row => [row.sku, row]));
    const inventoryItems = new Map((selection.inventoryReady ? context.inventory.items : []).map(row => [row.Code, row]));
    stats.matched = selection.products.length;
    stats.added = selection.added;
    stats.discoveryDeferred = selection.discoveryDeferred;
    stats.missingFromApi = selection.absentExisting;
    for (const product of selection.products) {
      const normalized = buildProduct(product, existing.get(product.sku), observedAt, inventoryItems.get(product.sku), context.inventory?.observed_at);
      await upsertProduct(client, normalized);
      if (normalized.details.supplierPriceStatus === 'unknown') stats.unverifiedPrices.push(product.sku);
      stats.synced++;
    }
    for (const product of explicitSuccessionProducts) {
      if (await upsertSkuSuccession(client, product)) stats.skuSuccessions += 1;
    }
    await recordCatalogueLifecycle(client, products, observedAt);
    await saveCatalogueEvidence(client, products, observedAt);
    // An absent/discontinued article is not an upstream failure and does not
    // mean stock zero. Its lifecycle and prior observations remain available.
    await finishDataSync(client, 'victron', { observedAt, status: stats.unverifiedPrices.length ? 'partial' : 'success',
      error: stats.unverifiedPrices.length ? 'Incomplete supplier prices; retained saved prices.' : null,
      counts: { synced: stats.synced, missing: stats.missingFromApi.length, added: stats.added.length, unverifiedPrices: stats.unverifiedPrices.length } });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally {
    client.release();
  }

  // Media failures have their own durable retry state. They must not relabel
  // a complete, successfully published stock catalogue as a failed import.
  try { await refreshMissingMedia(stats, products); }
  catch { stats.mediaError = 'Photo maintenance did not complete; the saved stock catalogue remains available.'; }
  stats.requests = http.calls;
  console.log(JSON.stringify(stats, null, 2));
}

main().catch(async (error) => {
  await finishDataSync(pool, 'victron', { status: 'failed', error }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (runLocked) await runClient.query("SELECT pg_advisory_unlock(hashtext('victron-catalogue-sync'))");
  runClient?.release();
  await pool.end();
});
