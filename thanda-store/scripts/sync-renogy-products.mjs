#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import pg from 'pg';

const { Pool } = pg;
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

if (!INITIAL_TOKEN && (!RENOGY_EMAIL || !RENOGY_PASSWORD)) {
  console.error('RENOGY_BEARER_TOKEN or RENOGY_EMAIL plus RENOGY_PASSWORD is required.');
  process.exit(1);
}

let authToken = normalizeToken(INITIAL_TOKEN) || readCachedToken();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST || 'localhost',
  database: process.env.POSTGRES_DATABASE,
  password: process.env.POSTGRES_PASSWORD,
  port: Number(process.env.POSTGRES_PORT || 5432),
});

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

function firstImageUrl(detail) {
  const imageSets = [
    detail.item_view_image,
    detail.item_cover_image,
    detail.item_view_image_by_bc,
  ];
  for (const value of imageSets) {
    const images = Array.isArray(value) ? value : value ? [value] : [];
    for (const image of images) {
      const url = image?.link || image?.url || image?.originalUrl;
      if (url) return url;
    }
  }
  return '';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildProduct(row, wrapper, detail) {
  const sku = row.SKU;
  const price = numberOrNull(detail.unitPrice) ?? numberOrNull(wrapper.data?.amount) ?? numberOrNull(detail.basic_price) ?? 0;
  const originalPrice = numberOrNull(detail.originalPrice);
  const stockOnHand = numberOrNull(detail.inventory) ?? numberOrNull(wrapper.data?.inventory) ?? numberOrNull(row.Stock) ?? 0;

  return {
    sku,
    supplier: 'renogy',
    supplier_item_id: wrapper.id,
    name: detail.item_view_title || detail.description || detail.name || row.Description || sku,
    category: detail.item_view_type || wrapper.data?.item_view_type || 'uncategorized',
    price,
    image_url: firstImageUrl(detail),
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
      hasImage: Boolean(firstImageUrl(detail)),
    },
  };
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      image_url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'uncategorized',
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier TEXT NOT NULL DEFAULT 'renogy'");
  await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_item_id TEXT');
  await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_on_hand INTEGER NOT NULL DEFAULT 0');
  await client.query('CREATE INDEX IF NOT EXISTS products_supplier_item_id_idx ON products (supplier, supplier_item_id)');
}

async function upsertProduct(client, product) {
  await client.query(
    `
      INSERT INTO products (
        sku, supplier, supplier_item_id, name, price, image_url, category,
        stock_on_hand, details, last_updated
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
      ON CONFLICT (sku) DO UPDATE SET
        supplier = EXCLUDED.supplier,
        supplier_item_id = EXCLUDED.supplier_item_id,
        name = EXCLUDED.name,
        price = EXCLUDED.price,
        image_url = EXCLUDED.image_url,
        category = EXCLUDED.category,
        stock_on_hand = EXCLUDED.stock_on_hand,
        details = EXCLUDED.details,
        last_updated = NOW()
    `,
    [
      product.sku,
      product.supplier,
      product.supplier_item_id,
      product.name,
      product.price,
      product.image_url,
      product.category,
      product.stock_on_hand,
      JSON.stringify(product.details),
    ],
  );
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
    await ensureSchema(client);
    for (const row of rows) {
      const sku = row.SKU;
      try {
        const wrapper = await findRenogyItemBySku(sku);
        if (!wrapper) {
          stats.notFound.push(sku);
          continue;
        }
        const detail = await fetchRenogyDetail(wrapper.id);
        const product = buildProduct(row, wrapper, detail);
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
