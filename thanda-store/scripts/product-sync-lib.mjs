import pg from 'pg';

const { Pool } = pg;

export function createPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST || 'localhost',
    database: process.env.POSTGRES_DATABASE,
    password: process.env.POSTGRES_PASSWORD,
    port: Number(process.env.POSTGRES_PORT || 5432),
  });
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeText(value, fallback = '') {
  return String(value || fallback).trim();
}

export async function ensureProductSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      sku TEXT NOT NULL,
      supplier TEXT NOT NULL DEFAULT 'renogy',
      supplier_item_id TEXT,
      name TEXT NOT NULL,
      price NUMERIC(12, 2) NOT NULL DEFAULT 0,
      image_url TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'uncategorized',
      stock_on_hand INTEGER NOT NULL DEFAULT 0,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier TEXT NOT NULL DEFAULT 'renogy'");
  await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_item_id TEXT');
  await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_on_hand INTEGER NOT NULL DEFAULT 0');
  await client.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT \'{}\'::jsonb');
  await client.query("UPDATE products SET supplier = 'renogy' WHERE supplier IS NULL OR supplier = ''");
  await client.query('ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS products_supplier_sku_key ON products (supplier, sku)');
  await client.query('CREATE INDEX IF NOT EXISTS products_supplier_item_id_idx ON products (supplier, supplier_item_id)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS victron_sku_successions (
      predecessor_sku TEXT PRIMARY KEY,
      successor_sku TEXT NOT NULL,
      source_description TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (predecessor_sku <> successor_sku)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS victron_sku_successions_successor_idx ON victron_sku_successions (successor_sku)');
}

export async function upsertProduct(client, product) {
  await client.query(
    `
      INSERT INTO products (
        sku, supplier, supplier_item_id, name, price, image_url, category,
        stock_on_hand, details, last_updated
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
      ON CONFLICT (supplier, sku) DO UPDATE SET
        supplier_item_id = EXCLUDED.supplier_item_id,
        name = EXCLUDED.name,
        price = EXCLUDED.price,
        image_url = COALESCE(NULLIF(EXCLUDED.image_url, ''), products.image_url),
        category = EXCLUDED.category,
        stock_on_hand = EXCLUDED.stock_on_hand,
        details = products.details || EXCLUDED.details,
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
