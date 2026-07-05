# Thanda Store

Dealer inventory portal for Thanda Store. The repository currently contains a Next.js storefront plus helper scripts used to import and enrich product data from warehouse and supplier sources.

## Repository layout

- `thanda-store/` - Next.js application for the dealer portal.
- `thanda-store/scripts/sync-renogy-products.mjs` - warehouse-driven Renogy sync job.
- `db/products.sql` - PostgreSQL table setup for product data.
- `sync_db.js` - legacy CSV import helper.
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

Required environment variables:

```bash
DATABASE_URL=postgres://user:password@localhost:5432/thanda_store
RENOGY_EMAIL=warwick@example.com
RENOGY_PASSWORD=...
RENOGY_TOKEN_CACHE_FILE=/var/lib/thanda-store/renogy-token.json
RENOGY_PRODUCT_SOURCE=export
DEFAULT_B2B_DISCOUNT_PERCENT=30
WAREHOUSE_CSV=/absolute/path/to/warehouse_inventory.csv
```

`DATABASE_URL` is preferred. `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` are also supported.
`RENOGY_PRODUCT_SOURCE` defaults to `export`; set it to `csv` only when deliberately testing with a local warehouse CSV.
`RENOGY_BEARER_TOKEN` is still supported as a bootstrap override, but production should use `RENOGY_EMAIL` and `RENOGY_PASSWORD` so the sync can refresh an expired token automatically. The refreshed token is cached in `RENOGY_TOKEN_CACHE_FILE` with file mode `0600`.
`DEFAULT_B2B_DISCOUNT_PERCENT` is the temporary buyer discount until user-specific pricing exists. The API clamps it to a maximum of 40% off recommended retail.

## Pricing rules

The Renogy sync stores Renogy's unit price as Thanda's distributor cost. That value must never be displayed as the buyer price.

`GET /api/products` calculates buyer-facing prices from recommended retail:

- `recommended_retail_ex_vat` = Renogy recommended retail price divided by 1.15.
- `your_price_ex_vat` = `recommended_retail_ex_vat` less the configured B2B discount.
- B2B discount is capped server-side at 40%, even if environment configuration or future user data asks for more.

All customer-facing prices in the portal are displayed excluding VAT.

## Database

The app expects a PostgreSQL database with a `products` table. Apply the setup SQL with:

```bash
psql "$DATABASE_URL" -f db/products.sql
```

The sync job also creates or extends the required table defensively before writing products.

## Renogy sync

Run a one-off sync from the repository root:

```bash
cd thanda-store
npm run sync:renogy
```

The sync is intentionally warehouse-driven:

1. Request Renogy's all-products export with `POST /api/pp/report/item/export`.
2. Download the signed CSV from the object-storage URL returned by `common/file/preSignedUrl`.
3. Use the export as the master SKU and available-stock list.
4. For each SKU, call Renogy `item/listPage` with `itemViewType: []` and `productSearch: <SKU>`.
5. Use the returned Renogy wrapper `id` as the internal supplier item ID.
6. Fetch `item/{id}` for current price, name, category, and image metadata.
7. Upsert into PostgreSQL keyed by `sku`.

This is more reliable than scanning hand-picked category batches. Direct testing found that all 95 warehouse SKUs resolve through SKU search, while the old category scan only found 22 products.
The export itself contains SKU, description, available stock, in-transit quantity, and expected delivery date; it does not contain prices or image URLs.

### Five-minute schedule

On the VPS, prefer a systemd timer over a long-running loop. It gives you logs, restart behaviour, and avoids overlapping runs.

`/etc/systemd/system/thanda-renogy-sync.service`:

```ini
[Unit]
Description=Sync Thanda Store products from Renogy

[Service]
Type=oneshot
WorkingDirectory=/opt/thanda-store/thanda-store
EnvironmentFile=/etc/thanda-store.env
ExecStart=/usr/bin/npm run sync:renogy
```

`/etc/systemd/system/thanda-renogy-sync.timer`:

```ini
[Unit]
Description=Run Thanda Renogy sync every five minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=thanda-renogy-sync.service

[Install]
WantedBy=timers.target
```

Enable it with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now thanda-renogy-sync.timer
systemctl list-timers thanda-renogy-sync.timer
journalctl -u thanda-renogy-sync.service -n 100 --no-pager
```

Five minutes is a reasonable starting point for a small catalogue. If Renogy throttles or the run time approaches the interval, move to ten or fifteen minutes and show `last_updated` in the admin view.

### Authentication

The sync job authenticates directly against Renogy's portal API. On startup it uses a cached token when available, validates it with `GET /api/sc/portal/user/info`, and logs in again with `POST /api/sc/portal/user/prelogin` when the token is missing or expired. During a run, any `401` response triggers one token refresh and one retry of the failed request.

The older browser-token helper scripts are for debugging only. Do not use browser token sniffing as the production refresh mechanism.

## Current technical issues

### Git repository shape

This repository previously contained a nested git repository for the app. That caused GitHub to receive a gitlink pointer instead of normal application files. The app should be tracked as ordinary files under `thanda-store/`.

### Supplier enrichment

Stock levels, names, prices, and images are now fetched through SKU-driven Renogy API lookup. The important detail is that `itemViewType` must be empty when searching by SKU; fixed category batches miss valid products.

### Secrets

`sync_renogy_inventory.py` currently contains a bearer token from the supplier API work. Treat that token as exposed because it has been committed before. Rotate or revoke it, then replace hard-coded credentials with environment variables.

### Storefront behaviour

The portal is currently a read-only product catalogue. Search input, cart actions, user-specific discount selection, and support actions are visual placeholders and should either be implemented or simplified so the UI does not imply unavailable behaviour.

## Suggested next steps

1. Rotate supplier/API credentials and move secrets to environment variables.
2. Add alerting if API login starts failing.
3. Add alerting if a sync run fails or if products are missing from Renogy.
4. Implement or remove placeholder cart/support controls.
5. Add a short changelog once the first real deployment baseline is agreed.
