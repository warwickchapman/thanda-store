#!/usr/bin/env node

import fs from 'node:fs';
import { startDataSync, finishDataSync } from '../src/lib/data-sync-state.mjs';
import { observeRenogyStock } from '../src/lib/renogy-stock.mjs';
import { RenogyAuthError, RenogyRateLimitError, ensureSupplierAuthSchema, recordRenogyAuthFailure, resolveRenogyAuthFailure, recordRenogyRateLimit, renogyRetryDeadline } from '../src/lib/supplier-auth-alerts.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import {
  createPool,
  ensureProductSchema,
  numberOrNull,
  upsertProduct,
} from './product-sync-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.RENOGY_BASE_URL || 'https://partner.renogy.com/prod-api/api/sc/portal';
const API_ROOT = BASE_URL.replace(/\/api\/sc\/portal\/?$/, '');
const INITIAL_TOKEN = process.env.RENOGY_BEARER_TOKEN;
const RENOGY_EMAIL = process.env.RENOGY_EMAIL;
const RENOGY_PASSWORD = process.env.RENOGY_PASSWORD;
const TOKEN_CACHE_FILE = process.env.RENOGY_TOKEN_CACHE_FILE || path.resolve(__dirname, '../../.renogy-token.json');
const WAREHOUSE_CSV = process.env.WAREHOUSE_CSV || path.resolve(__dirname, '../../warehouse_inventory.csv');
const PRODUCT_SOURCE = process.env.RENOGY_PRODUCT_SOURCE || 'export';
const REQUEST_TIMEOUT_MS = Number(process.env.RENOGY_REQUEST_TIMEOUT_MS || 12000);

let authToken = readCachedToken() || normalizeToken(INITIAL_TOKEN);
let loginAttempted = false;
let currentUserDetails = null;
let syncStarted = false;

const pool = createPool();

function normalizeExportRow(row) {
  return {
    SKU: row['Item No'],
    Description: row['Item Description'],
    Stock: row.Available,
    InTransit: row['In transit'],
    ExpectedDeliveryDate: row['Expected Delivery Date'],
    source: 'renogy-export',
  };
}

function normalizeWarehouseRow(row) {
  return {
    SKU: row.SKU,
    Description: row.Description,
    Stock: row.Stock,
    InTransit: row['In transit'],
    ExpectedDeliveryDate: row['Expected Delivery Date'],
    source: 'warehouse-csv',
  };
}

function parseProductCsv(csv) {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  return rows
    .map((row) => (row['Item No'] ? normalizeExportRow(row) : normalizeWarehouseRow(row)))
    .filter((row) => row.SKU);
}

function readWarehouseRows() {
  const csv = fs.readFileSync(WAREHOUSE_CSV, 'utf8');
  return parseProductCsv(csv);
}

function normalizeToken(token) {
  return token?.replace(/^Bearer\s+/i, '').trim() || '';
}

function readCachedToken() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
    return normalizeToken(data.token);
  } catch {
    return '';
  }
}

function writeCachedToken(token) {
  fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true });
  const temporary = `${TOKEN_CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    token,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, TOKEN_CACHE_FILE);
}

function renogyHeaders(referer = 'https://partner.renogy.com/product') {
  if (!authToken) {
    throw new Error('No Renogy auth token is available');
  }
  return {
    Authorization: authToken,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Referer: referer,
    'User-Agent': 'ThandaStoreSync/1.0',
  };
}

function isAuthFailure(body, status) {
  return [401, 403].includes(status) || [401, 403].includes(Number(body?.code));
}

async function loginRenogy() {
  if (loginAttempted || !RENOGY_EMAIL || !RENOGY_PASSWORD) throw new RenogyAuthError();
  loginAttempted = true;
  const json = await fetchJson(`${BASE_URL}/user/prelogin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://partner.renogy.com/login',
      'User-Agent': 'ThandaStoreSync/1.0',
    },
    body: JSON.stringify({
      email: RENOGY_EMAIL.trim(),
      password: RENOGY_PASSWORD,
    }),
  }, { retryAuth: false, loginRequest: true });

  if (json.code !== 200 || !json.data?.token) {
    throw new RenogyAuthError();
  }
  authToken = normalizeToken(json.data.token);
  writeCachedToken(authToken);
  return authToken;
}

async function fetchJson(url, options, behavior = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (response.status === 429 || Number(body?.code) === 429) {
      await recordRenogyRateLimit(pool, response.headers);
      throw new RenogyRateLimitError();
    }
    if (isAuthFailure(body, response.status)) {
      if (behavior.retryAuth === false) throw new RenogyAuthError();
      await loginRenogy();
      return fetchJson(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: authToken,
        },
      }, { retryAuth: false });
    }
    if (!response.ok) {
      if (behavior.loginRequest) throw new Error(`Renogy login request failed (HTTP ${response.status}).`);
      const message = body?.msg || body?.message || text.slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (response.status === 429) {
      await recordRenogyRateLimit(pool, response.headers);
      throw new RenogyRateLimitError();
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCurrentUser() {
  if (currentUserDetails) return currentUserDetails;
  const json = await fetchJson(`${BASE_URL}/user/info`, {
    method: 'GET',
    headers: renogyHeaders(),
  });
  if (json.code !== 200) {
    throw new Error(`Renogy user info returned code ${json.code}: ${json.msg || 'unknown error'}`);
  }
  currentUserDetails = json.data;
  return currentUserDetails;
}

async function fetchProductExportRows() {
  const user = await fetchCurrentUser();
  if (!user?.id) {
    throw new Error('Renogy user info did not include a contact id');
  }

  const exportJson = await fetchJson(`${API_ROOT}/api/pp/report/item/export`, {
    method: 'POST',
    headers: renogyHeaders(),
    body: JSON.stringify({ contactId: user.id }),
  });
  if (exportJson.code !== 200) {
    throw new Error(`Renogy export returned code ${exportJson.code}: ${exportJson.msg || 'unknown error'}`);
  }
  const fileName = exportJson.data?.fileName;
  if (!fileName) {
    throw new Error('Renogy export did not return a fileName');
  }

  const signedJson = await fetchJson(`${BASE_URL}/common/file/preSignedUrl?fileName=`, {
    method: 'GET',
    headers: renogyHeaders(),
  });
  if (signedJson.code !== 200 || !signedJson.data?.url) {
    throw new Error(`Renogy preSignedUrl returned code ${signedJson.code}: ${signedJson.msg || 'unknown error'}`);
  }

  const csv = await fetchText(`${signedJson.data.url}${fileName}`, {
    method: 'GET',
    headers: { Accept: 'text/csv, application/octet-stream, */*' },
  });
  const stockObservedAt = new Date().toISOString();
  return parseProductCsv(csv).map(row => ({ ...row, stockObservedAt }));
}

async function loadProductRows() {
  if (PRODUCT_SOURCE === 'csv') return readWarehouseRows();
  if (PRODUCT_SOURCE !== 'export') {
    throw new Error(`Unknown RENOGY_PRODUCT_SOURCE "${PRODUCT_SOURCE}". Use "export" or "csv".`);
  }
  return fetchProductExportRows();
}

async function ensureAuthenticated() {
  if (!authToken) await loginRenogy();
  await fetchCurrentUser();
}

async function findRenogyItemBySku(sku) {
  const body = {
    itemViewType: [],
    pageNum: 1,
    pageSize: 10,
    isDiscount: false,
    discountId: 77,
    productSearch: sku,
    isMarketingSupport: false,
  };
  const json = await fetchJson(`${BASE_URL}/item/listPage`, {
    method: 'POST',
    headers: renogyHeaders(),
    body: JSON.stringify(body),
  });
  if (json.code !== 200) {
    throw new Error(`Renogy search returned code ${json.code}: ${json.msg || 'unknown error'}`);
  }
  const rows = json.data?.rows || [];
  return rows.find((row) => String(row.data?.id || '').toUpperCase() === sku.toUpperCase()) || null;
}

async function fetchRenogyDetail(itemId) {
  const json = await fetchJson(`${BASE_URL}/item/${itemId}`, {
    method: 'GET',
    headers: renogyHeaders(`https://partner.renogy.com/product/item/${itemId}`),
  });
  if (json.code !== 200) {
    throw new Error(`Renogy detail returned code ${json.code}: ${json.msg || 'unknown error'}`);
  }
  return json.data?.data || {};
}

function objectStorageKey(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('.objectstorage.')) return '';
    const marker = '/o/';
    const index = parsed.pathname.indexOf(marker);
    if (index === -1) return '';
    return decodeURIComponent(parsed.pathname.slice(index + marker.length));
  } catch {
    return '';
  }
}

async function signedObjectStorageUrl(url) {
  if (url.includes('/p/')) return url;
  const fileName = objectStorageKey(url);
  if (!fileName) return '';
  const signedJson = await fetchJson(`${BASE_URL}/common/file/preSignedUrl?fileName=${encodeURIComponent(fileName)}`, {
    method: 'GET',
    headers: renogyHeaders(),
  });
  if (signedJson.code !== 200 || !signedJson.data?.url) return '';
  return `${signedJson.data.url}${fileName}`;
}

async function firstImageUrl(detail) {
  const imageSets = [
    detail.item_view_image,
    detail.item_cover_image,
    detail.item_view_image_by_bc,
    detail.item_cover_image_by_bc,
    detail.images,
    detail.image,
  ];
  const urls = [];
  for (const value of imageSets) {
    const images = Array.isArray(value) ? value : value ? [value] : [];
    for (const image of images) {
      if (typeof image === 'string') urls.push(...image.split(','));
      urls.push(image?.url, image?.originalUrl, image?.link);
    }
  }
  const cleanUrls = urls
    .map((url) => (typeof url === 'string' ? url.trim() : ''))
    .filter((url) => /^https?:\/\//i.test(url));
  const presigned = cleanUrls.find((url) => url.includes('.objectstorage.') && url.includes('/p/'));
  if (presigned) return presigned;
  for (const url of cleanUrls) {
    const signedUrl = await signedObjectStorageUrl(url);
    if (signedUrl) return signedUrl;
  }
  return cleanUrls.find((url) => !url.includes('.objectstorage.')) || cleanUrls[0] || '';
}

async function buildProduct(row, wrapper, detail, observedAt) {
  const sku = row.SKU;
  const price = numberOrNull(detail.unitPrice) ?? numberOrNull(wrapper.data?.amount) ?? numberOrNull(detail.basic_price) ?? 0;
  const originalPrice = numberOrNull(detail.originalPrice);
  const stock = observeRenogyStock(detail, row, observedAt);
  const imageUrl = await firstImageUrl(detail);

  return {
    sku,
    supplier: 'renogy',
    supplier_item_id: wrapper.id,
    name: detail.item_view_title || detail.description || detail.name || row.Description || sku,
    category: detail.item_view_type || wrapper.data?.item_view_type || 'uncategorized',
    price,
    image_url: imageUrl,
    stock_on_hand: stock.quantity ?? 0,
    details: {
      originalPrice,
      supplierObservedAt: stock.observedAt,
      supplierStockStatus: stock.quantity === null ? 'unknown' : 'known',
      supplierStockSource: stock.source,
      // Renogy's product-detail originalPrice is list price excluding VAT.
      // The partner portal renders the same amount with 15% VAT included.
      recommendedRetailExVat: originalPrice,
      recommendedRetailPriceVatMode: 'ex_vat',
      basicPrice: numberOrNull(detail.basic_price),
      unitPrice: numberOrNull(detail.unitPrice),
      unitPriceAfterDiscount: numberOrNull(detail.unitPriceAfterDiscount),
      productListStock: numberOrNull(row.Stock),
      productListSource: row.source,
      inTransit: numberOrNull(row.InTransit),
      expectedDeliveryDate: row.ExpectedDeliveryDate || null,
      availableOverseas: numberOrNull(detail.available_overseas),
      safetyInventory: numberOrNull(detail.safety_inventory),
      itemModel: detail.item_model,
      productUrl: `https://partner.renogy.com/product/item/${wrapper.id}`,
      ...(typeof detail.description === 'string' && detail.description.trim() ? { description: detail.description } : {}),
      lastRenogyModified: detail.lastModified,
      hasImage: Boolean(imageUrl),
    },
  };
}

async function main() {
  const authOnly = process.argv.includes('--check-auth');
  await ensureSupplierAuthSchema(pool);
  const retryAt = await renogyRetryDeadline(pool);
  if (retryAt) {
    console.log(`Renogy cooldown until ${new Date(retryAt).toISOString()}; no provider requests made.`);
    if (authOnly) process.exitCode = 75;
    return;
  }
  if (!authOnly) { await startDataSync(pool, 'renogy'); syncStarted = true; }
  if (!authToken && (!RENOGY_EMAIL || !RENOGY_PASSWORD)) throw new RenogyAuthError();
  await ensureAuthenticated();
  await resolveRenogyAuthFailure(pool);
  if (authOnly) { console.log('Renogy authentication verified. No catalogue or stock was changed.'); return; }
  const rows = await loadProductRows();
  const client = await pool.connect();
  const stats = {
    total: rows.length,
    synced: 0,
    notFound: [],
    failed: [],
    missingImages: [],
  };

  try {
    await ensureProductSchema(client);
    for (const row of rows) {
      const sku = row.SKU;
      try {
        const wrapper = await findRenogyItemBySku(sku);
        if (!wrapper) {
          stats.notFound.push(sku);
          continue;
        }
        const detail = await fetchRenogyDetail(wrapper.id);
        const product = await buildProduct(row, wrapper, detail, new Date().toISOString());
        await upsertProduct(client, product);
        stats.synced += 1;
        if (!product.image_url) stats.missingImages.push(sku);
      } catch (error) {
        // Stop the run on authentication loss; do not spend a login request for
        // every remaining SKU or report a rejected connection as partial stock.
        if (error instanceof RenogyAuthError || error instanceof RenogyRateLimitError) throw error;
        stats.failed.push({ sku, error: error.message });
      }
    }
  } finally {
    client.release();
  }

  await finishDataSync(pool, 'renogy', {
    status: stats.failed.length || stats.notFound.length ? 'partial' : 'success',
    // Per-product observations remain the stock freshness authority.
    observedAt: new Date().toISOString(),
    error: stats.failed.length || stats.notFound.length ? 'Incomplete catalogue update' : null,
    counts: { synced: stats.synced, failed: stats.failed.length, missing: stats.notFound.length },
  });
  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed.length > 0) process.exitCode = 1;
}

async function runLocked() {
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query('SELECT pg_try_advisory_lock(742042) AS locked')).rows[0].locked;
    if (!locked) {
      console.log('Another Renogy sync or authentication check is running.');
      if (process.argv.includes('--check-auth')) process.exitCode = 75;
      return;
    }
    await main();
  } catch (error) {
    // Persist the outcome while the source lock is still held, so a concurrent
    // successful check cannot be followed by this older failure reopening it.
    if (error instanceof RenogyAuthError) {
      try { await recordRenogyAuthFailure(pool); }
      catch { console.error('Renogy authentication incident could not be recorded. Check the database.'); }
    }
    if (syncStarted) await finishDataSync(pool, 'renogy', { status: 'failed', error }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    try { if (locked) await db.query('SELECT pg_advisory_unlock(742042)'); }
    finally { db.release(); }
  }
}

runLocked().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => pool.end());
