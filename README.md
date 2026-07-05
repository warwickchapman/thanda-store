# Thanda Store

Dealer inventory portal for Thanda Store. The repository currently contains a Next.js storefront plus helper scripts used to import and enrich product data from warehouse and supplier sources.

## Repository layout

- `thanda-store/` - Next.js application for the dealer portal.
- `sync_db.js` - imports `master_product_import.csv` rows into PostgreSQL.
- `sync_renogy_inventory.py` - experimental Renogy enrichment script.
- `renogy_*` scripts - supplier-specific authentication/API experiments.

Generated local data files such as CSV exports, Excel reports, `node_modules`, and Next.js build output are intentionally ignored.

## Local development

```bash
cd thanda-store
npm install
npm run dev
```

The app reads products from `GET /api/products`, which queries PostgreSQL through `src/lib/db.ts`.

## Database

The current app expects a PostgreSQL database with a `products` table containing at least:

- `id`
- `sku`
- `name`
- `price`
- `image_url`
- `category`
- `details`
- `last_updated`

The database connection is currently hard-coded in `thanda-store/src/lib/db.ts`. Before production hardening, move this to environment variables and document the required `.env` keys.

## Inventory import

The current import path is:

1. Produce or obtain `master_product_import.csv`.
2. Run `node sync_db.js` from the repository root.
3. The storefront reads the imported rows from PostgreSQL.

The import currently inserts rows directly and does not yet perform upserts or deletions. That is acceptable for a prototype, but the next version should make repeated imports idempotent.

## Current technical issues

### Git repository shape

This repository previously contained a nested git repository for the app. That caused GitHub to receive a gitlink pointer instead of normal application files. The app should be tracked as ordinary files under `thanda-store/`.

### Supplier enrichment

Stock levels can be imported from the warehouse report, but richer product data such as supplier images, canonical descriptions, and recommended prices depends on matching warehouse SKUs to supplier product IDs.

The Renogy API detail endpoint appears to require internal item IDs rather than plain warehouse SKUs. The current enrichment script only has a small set of known IDs, so it cannot enrich the full catalogue yet.

Colin's useful next step is to identify a reliable SKU-to-supplier-ID mapping source. Once that exists, the enrichment script can fetch product details deterministically instead of probing manually.

### Secrets

`sync_renogy_inventory.py` currently contains a bearer token from the supplier API work. Treat that token as exposed because it has been committed before. Rotate or revoke it, then replace hard-coded credentials with environment variables.

### Storefront behaviour

The portal is currently a read-only product catalogue. Search input, cart actions, dealer pricing rules, and support actions are visual placeholders and should either be implemented or simplified so the UI does not imply unavailable behaviour.

## Suggested next steps

1. Rotate supplier/API credentials and move secrets to environment variables.
2. Replace direct inserts in `sync_db.js` with idempotent upserts keyed by SKU.
3. Add a small schema/setup script for the `products` table.
4. Implement or remove placeholder storefront controls.
5. Add a short changelog once the first real deployment baseline is agreed.
