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
);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_sku_key;

CREATE UNIQUE INDEX IF NOT EXISTS products_supplier_sku_key
  ON products (supplier, sku);

CREATE INDEX IF NOT EXISTS products_supplier_item_id_idx
  ON products (supplier, supplier_item_id);
