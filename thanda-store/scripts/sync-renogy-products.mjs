#!/usr/bin/env node

import fs from 'node:fs';
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

let authToken = normalizeToken(INITIAL_TOKEN) || readCachedToken();

if (!authToken && (!RENOGY_EMAIL || !RENOGY_PASSWORD)) {
  console.error('RENOGY_BEARER_TOKEN, cached Renogy token, or RENOGY_EMAIL plus RENOGY_PASSWORD is required.');
  process.exit(1);
}

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
  fs.writeFileSync(TOKEN_CACHE_FILE, `${JSON.stringify({
    token,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
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
  return status === 401 || body?.code === 401;
}

async function loginRenogy() {
  if (!RENOGY_EMAIL || !RENOGY_PASSWORD) {
    throw new Error('Renogy token expired and RENOGY_EMAIL/RENOGY_PASSWORD are not configured');
  }
  const json = await fetchJson(`${BASE_URL}/user/prelogin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://partner.renogy.com/login',
      'User-Agent': 'ThandaStoreSync/1.0',
    },
    body: JSON.stringify({
      email: RENOGY_EMAIL.replace(/\s/g, ''),
      password: RENOGY_PASSWORD.replace(/\s/g, ''),
    }),
  }, { retryAuth: false });

  if (json.code !== 200 || !json.data?.token) {
    throw new Error(`Renogy login failed with code ${json.code}: ${json.msg || 'missing token'}`);
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
    if (isAuthFailure(body, response.status) && behavior.retryAuth !== false) {
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
  const json = await fetchJson(`${BASE_URL}/user/info`, {
    method: 'GET',
    headers: renogyHeaders(),
  });
  if (json.code !== 200) {
    throw new Error(`Renogy user info returned code ${json.code}: ${json.msg || 'unknown error'}`);
  }
  return json.data;
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
  return parseProductCsv(csv);
}

async function loadProductRows() {
  if (PRODUCT_SOURCE === 'csv') return readWarehouseRows();
  if (PRODUCT_SOURCE !== 'export') {
    throw new Error(`Unknown RENOGY_PRODUCT_SOURCE "${PRODUCT_SOURCE}". Use "export" or "csv".`);
  }
  return fetchProductExportRows();
}

async function ensureAuthenticated() {
  if (!authToken) {
    await loginRenogy();
    return;
  }
  try {
    await fetchCurrentUser();
  } catch (error) {
    if (!String(error.message).includes('401')) throw error;
    await loginRenogy();
  }
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

async function buildProduct(row, wrapper, detail) {
  const sku = row.SKU;
  const price = numberOrNull(detail.unitPrice) ?? numberOrNull(wrapper.data?.amount) ?? numberOrNull(detail.basic_price) ?? 0;
  const originalPrice = numberOrNull(detail.originalPrice);
  const stockOnHand = numberOrNull(detail.inventory) ?? numberOrNull(wrapper.data?.inventory) ?? numberOrNull(row.Stock) ?? 0;
  const imageUrl = await firstImageUrl(detail);

  return {
    sku,
    supplier: 'renogy',
    supplier_item_id: wrapper.id,
    name: detail.item_view_title || detail.description || detail.name || row.Description || sku,
    category: detail.item_view_type || wrapper.data?.item_view_type || 'uncategorized',
    price,
    image_url: imageUrl,
    stock_on_hand: stockOnHand,
    details: {
      originalPrice,
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
      lastRenogyModified: detail.lastModified,
      hasImage: Boolean(imageUrl),
    },
  };
}

async function main() {
  await ensureAuthenticated();
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
        const product = await buildProduct(row, wrapper, detail);
        await upsertProduct(client, product);
        stats.synced += 1;
        if (!product.image_url) stats.missingImages.push(sku);
      } catch (error) {
        stats.failed.push({ sku, error: error.message });
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
