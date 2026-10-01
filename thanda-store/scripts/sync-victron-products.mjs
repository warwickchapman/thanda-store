#!/usr/bin/env node

import fs from 'node:fs';
import { recordCatalogueLifecycle } from '../src/lib/xero-item-create.mjs';
import { createVictronHttp, ensureVictronHttpSchema, nextCatalogueRun } from '../src/lib/victron-http.mjs';
import { startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';
import { observeVictronSupplierStock } from '../src/lib/data-freshness.mjs';
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
const ALLOWLIST_FILE = process.env.VICTRON_ALLOWLIST_FILE
  || path.resolve(__dirname, '../data/victron-zar-2026-q3-skus.json');
const RATE_LIMIT_CACHE_FILE = process.env.VICTRON_RATE_LIMIT_CACHE_FILE
  || path.resolve(__dirname, '../../.victron-rate-limit.json');

const pool = createPool();
const http = createVictronHttp({ pool, apiKey: API_KEY || '', apiRoot: API_ROOT,
  component: FETCH_EXTENDED ? 'catalogue-extended' : 'catalogue',
  trigger: process.argv.includes('--manual') ? 'manual' : 'scheduled', timeoutMs: REQUEST_TIMEOUT_MS, maxRequests: FETCH_EXTENDED ? 100 : 20 });
let runClient;
let runLocked = false;

function readRateLimitCache() {
  try {
    return JSON.parse(fs.readFileSync(RATE_LIMIT_CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function loadAllowedSkus() {
  const data = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
  return new Set((data.skus || []).map((sku) => String(sku).trim().toUpperCase()).filter(Boolean));
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
  const productData = product.product_data || {};
  const mainImage = productData.main_images?.[0]?.url;
  return normalizeText(mainImage || productData.image || '');
}

function successorSkuFromDescription(description) {
  // Victron marks a replacement explicitly as: "If 0, order <SKU>". Do not
  // infer a succession from any other free-form product-description wording.
  const match = String(description || '').match(/\bif\s+0\s*,?\s*order\s+([A-Z0-9-]+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function buildProduct(product, extendedProduct, observedAt) {
  const richProduct = extendedProduct || product;
  const productData = richProduct.product_data || {};
  const accountPrice = numberOrNull(product.price) ?? 0;
  const apiRecommendedRetailExVat = numberOrNull(product.enduser_price_zar?.price);
  const recommendedRetailExVat = THANDA_DISCOUNT_FACTOR > 0
    ? Math.round((accountPrice / THANDA_DISCOUNT_FACTOR) * 100) / 100
    : apiRecommendedRetailExVat;
  const category = normalizeText(product.category || product.subcategory || productData.category, 'uncategorized');
  const name = normalizeText(product.description || productData.name, product.sku);
  const successorSku = successorSkuFromDescription(name);
  const imageUrl = selectImageUrl(richProduct);
  const is120vAc = /(^|[^0-9])120V([^0-9]|$)/i.test(name);
  const hidden = category.toLowerCase() === 'solar home system';
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
  };

  if (extendedProduct) {
    details.imageSource = imageUrl ? 'victron-products-extended' : null;
    if (typeof productData.description === 'string' && productData.description.trim()) details.description = productData.description;
    details.documents = productData.documents || [];
    details.technicalData = productData.pms_technical_data || [];
  }

  return {
    sku: normalizeText(product.sku).toUpperCase(),
    supplier: 'victron',
    supplier_item_id: normalizeText(product.sku).toUpperCase(),
    name,
    category,
    price: accountPrice,
    image_url: imageUrl,
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

  const allowedSkus = loadAllowedSkus();
  const products = await fetchPagedProducts('products');
  const observedAt = new Date().toISOString();
  const priceListProducts = products.filter((product) => allowedSkus.has(String(product.sku || '').toUpperCase()));
  // Successions are supplier catalogue data, not an assortment decision. Scan
  // the complete E-Order response so a replacement relationship is retained
  // even when the retired product is outside the storefront price-list scope.
  const explicitSuccessionProducts = products.filter((product) =>
    Boolean(successorSkuFromDescription(product.description || product.product_data?.name)),
  );
  // The quarterly price list remains the normal catalogue authority. An
  // explicit Victron "If 0, order <SKU>" marker is the narrow exception: the
  // named successor must be available so a retired predecessor can transition
  // cleanly without manually editing each quarter's allow-list.
  const successorSkus = new Set(priceListProducts.map((product) => successorSkuFromDescription(product.description || product.product_data?.name)).filter(Boolean));
  const allowedProducts = products.filter((product) => {
    const sku = String(product.sku || '').toUpperCase();
    return allowedSkus.has(sku) || successorSkus.has(sku);
  });
  const extendedBySku = new Map();
  const extendedFailures = [];

  if (FETCH_EXTENDED) {
    for (const product of allowedProducts) {
      const sku = String(product.sku || '').toUpperCase();
      try {
        extendedBySku.set(sku, await fetchExtendedProduct(sku));
      } catch (error) {
        extendedFailures.push({ sku, error: error.message });
        if (String(error.message).includes('Victron HTTP 429')) break;
      }
      if (EXTENDED_REQUEST_DELAY_MS > 0) await sleep(EXTENDED_REQUEST_DELAY_MS);
    }
  }

  const client = await pool.connect();
  const stats = {
    allowed: allowedSkus.size,
    explicitSuccessors: successorSkus.size,
    explicitSuccessions: explicitSuccessionProducts.length,
    apiProducts: products.length,
    matched: allowedProducts.length,
    synced: 0,
    skuSuccessions: 0,
    missingFromApi: [],
    missingImagesAfterExtended: [],
    failed: [],
    extendedFailures,
    extended: FETCH_EXTENDED,
  };

  try {
    await ensureProductSchema(client);
    const matchedSkus = new Set(allowedProducts.map((product) => String(product.sku || '').toUpperCase()));
    stats.missingFromApi = [...allowedSkus].filter((sku) => !matchedSkus.has(sku)).sort();

    for (const product of allowedProducts) {
      const sku = String(product.sku || '').toUpperCase();
      try {
        const normalized = buildProduct(product, extendedBySku.get(sku), observedAt);
        await upsertProduct(client, normalized);
        stats.synced += 1;
        if (FETCH_EXTENDED && !normalized.image_url) stats.missingImagesAfterExtended.push(sku);
      } catch (error) {
        stats.failed.push({ sku, error: error.message });
      }
    }
    // Only explicit Victron "If 0, order <SKU>" annotations qualify. Do not
    // infer replacements from similarly named article codes.
    for (const product of explicitSuccessionProducts) {
      if (await upsertSkuSuccession(client, product)) stats.skuSuccessions += 1;
    }
    if (!stats.failed.length) {
      await client.query('BEGIN');
      try { await recordCatalogueLifecycle(client, products, observedAt); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    client.release();
  }

  await finishDataSync(pool, 'victron', {
    status: stats.failed.length || stats.missingFromApi.length || extendedFailures.length ? 'partial' : 'success',
    observedAt,
    error: stats.failed.length || stats.missingFromApi.length || extendedFailures.length ? 'Incomplete catalogue update' : null,
    counts: { synced: stats.synced, failed: stats.failed.length, missing: stats.missingFromApi.length, extendedFailed: extendedFailures.length },
  });
  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed.length > 0) process.exitCode = 1;
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
