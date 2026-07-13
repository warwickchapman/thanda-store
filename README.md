# Thanda Store

Dealer inventory portal for Thanda Store. The repository currently contains a Next.js storefront plus helper scripts used to import and enrich product data from warehouse and supplier sources.

## Repository layout

- `thanda-store/` - Next.js application for the dealer portal.
- `thanda-store/scripts/sync-renogy-products.mjs` - warehouse-driven Renogy sync job.
- `thanda-store/scripts/sync-victron-products.mjs` - Victron E-Order sync job filtered to the South Africa ZAR price-list SKUs.
- `thanda-store/scripts/sync-xero-stock.mjs` - Xero local/KZN stock sync for Victron and selected Thanda-owned products.
- `thanda-store/scripts/generate-product-thumbnails.mjs` - batch thumbnail generator for supplier product images.
- `thanda-store/scripts/extract-victron-allowlist.mjs` - helper to regenerate the Victron South Africa SKU allow-list from a quarterly PDF price list.
- `thanda-store/scripts/seed-product-overrides.mjs` - manual product metadata and placeholder seed script for hidden categories, voltage notes, and non-API product lines.
- `thanda-store/data/victron-zar-2026-q3-skus.json` - generated Victron South Africa allow-list from the Q3 2026 ZAR price list.
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
VICTRON_EORDER_API_KEY=...
VICTRON_THANDA_DISCOUNT_FACTOR=0.525
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=https://oc.sensible.co.za/api/xero/callback
XERO_TOKEN_FILE=/var/lib/thanda-store/xero-token.json
XERO_CONNECT_SECRET=...
DEFAULT_B2B_DISCOUNT_PERCENT=30
WAREHOUSE_CSV=/absolute/path/to/warehouse_inventory.csv
```

`DATABASE_URL` is preferred. `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` are also supported.
`RENOGY_PRODUCT_SOURCE` defaults to `export`; set it to `csv` only when deliberately testing with a local warehouse CSV.
`RENOGY_BEARER_TOKEN` is still supported as a bootstrap override, but production should use `RENOGY_EMAIL` and `RENOGY_PASSWORD` so the sync can refresh an expired token automatically. The refreshed token is cached in `RENOGY_TOKEN_CACHE_FILE` with file mode `0600`.
`VICTRON_EORDER_API_KEY` is required for Victron sync. The Victron API documentation recommends sending the key directly in the `Authorization` header; do not store it in source control.
`VICTRON_THANDA_DISCOUNT_FACTOR` defaults to `0.525`, meaning the Victron E-Order account price is Thanda's price after a 47.5% distributor discount from retail.
`XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` are OAuth app credentials from Xero. `XERO_CONNECT_SECRET` protects the one-off `/api/xero/connect` URL because API routes are not behind the storefront Basic Auth middleware.
`DEFAULT_B2B_DISCOUNT_PERCENT` is the temporary buyer discount until user-specific pricing exists. The API clamps it to a maximum of 40% off recommended retail.
`RESEND_API_KEY` enables email OTP delivery through Resend. `OTP_FROM_EMAIL` defaults to `Thanda Store <sales@thanda.solar>`.

## Pricing rules

The Renogy sync stores Renogy's unit price as Thanda's distributor cost. That value must never be displayed as the buyer price.

`GET /api/products` calculates buyer-facing prices from recommended retail:

- `recommended_retail_ex_vat` = supplier recommended retail normalized to excluding VAT.
  - Renogy recommended retail is treated as including VAT unless the sync marks it otherwise.
  - Victron South Africa recommended retail is derived from the E-Order account price: `eorder_price / 0.525`. The PDF price list is used as the South Africa SKU allow-list, not as the pricing source. The raw Victron API retail field is kept in product details for comparison only.
- `your_price_ex_vat` = `recommended_retail_ex_vat` less the configured B2B discount.
- B2B discount is capped server-side at 40%, even if environment configuration or future user data asks for more.

All customer-facing prices in the portal are displayed excluding VAT.

Authenticated users can have supplier-specific discounts in `user_supplier_discounts`. Victron and Renogy discounts are capped at 40%. LoRa products do not receive a B2B discount; the Xero sales price is the buyer price.

## Portal users and OTP login

The storefront uses internal portal users with email OTP verification. Passwords are hashed in PostgreSQL and OTPs are stored as hashes with a short expiry.

Run the first-user seed with passwords supplied through environment variables:

```bash
cd thanda-store
BRANDON_PASSWORD='...' THANDA_PASSWORD='...' npm run seed:auth-users
```

Seeded users:

- `thanda` is an admin user with 40% Victron and 40% Renogy discount.
- `brandon_lgl` belongs to `Let's Get Lost` with 35% Victron and 35% Renogy discount.

Non-admin users cannot complete login until their organisation has a Xero contact link. Admin users can manage that manual link at `/admin/users`.

For email OTP, configure Resend:

```bash
RESEND_API_KEY=re_...
OTP_FROM_EMAIL='Thanda Store <sales@thanda.solar>'
```

Keep the Resend key in environment only. Do not commit it.

## Product display rules

Category labels are normalized in the storefront:

- `And` displays as `&`.
- `Dc` displays as `DC`.
- `Smartshunt` displays as `SmartShunt`.
- `(ev)` displays as `(EV)`.

Products with `details.hidden = true` are not returned by `GET /api/products`. Victron `Solar Home System` products are marked hidden because that category should not be displayed in the dealer portal.

Products with `details.is120vAc = true` display a USA flag and `Note: 120V AC`. The current automated rule only marks Victron product names that explicitly contain `120V`; ambiguous voltage cases should be reviewed manually.

Stock display has two concepts:

- `localStockOnHand` in `details` is Thanda/KZN stock. This will eventually come from Xero.
- `stock_on_hand` is supplier stock from the supplier API.

Renogy products display `Availability: 4-7 working days` plus `n in stock at Renogy Warehouse ZA`. If KZN stock is later present, it is shown first as `n in stock (KZN)`.

Victron products display `Availability: 3-5 working days` plus `n in stock at Victron Warehouse ZA`. If KZN stock is later present, it is shown first as `n in stock (KZN)`.

LoRa products are manufactured by Thanda, so they only display KZN stock. Hubble products currently use a manual availability string until an admin flip-control is added.

## Product image thumbnails

The storefront should not render supplier originals directly when a local thumbnail exists. Supplier images can be very large, inconsistently framed, or temporarily unavailable.

Generate local thumbnails after product syncs:

```bash
cd thanda-store
npm run images:thumbnails
```

The thumbnail job:

1. Reads products with `image_url` from PostgreSQL.
2. Downloads supplier originals only when the local thumbnail is missing, unless `--force` is passed.
3. Writes normalized WebP files to `public/product-images/<supplier>/<sku>.webp`.
4. Uses a white square canvas with padding so product cards have stable, mobile-friendly framing.

Useful targeted runs:

```bash
npm run images:thumbnails -- --supplier victron
npm run images:thumbnails -- --sku PMP482505012 --force
npm run images:thumbnails -- --limit 25
```

`GET /api/products` exposes `thumbnail_url` only when the local file exists. The storefront renders `thumbnail_url` first, falls back to the supplier `image_url`, then falls back to the placeholder icon. This keeps browsing resilient even if thumbnail generation misses a product.

## Xero stock sync

Xero is the source of truth for Thanda/KZN stock, not supplier warehouse stock. Supplier warehouse quantities still come from Renogy and Victron.

Run a one-off Xero stock sync:

```bash
cd thanda-store
npm run sync:xero-stock
```

The sync:

1. Reads and refreshes the OAuth token in `XERO_TOKEN_FILE` when needed.
2. Fetches Xero Items.
3. Matches exact SKU codes against products where `supplier = 'victron'`, plus the Thanda LoRa placeholder `LORA-RS-00120`.
4. Writes Xero `QuantityOnHand` into `details.localStockOnHand`.
5. Treats missing or untracked Xero items as local stock `0`.

For supplier-backed products, the storefront hides the KZN stock line when `localStockOnHand` is zero, then continues to show the supplier warehouse line. For example, a Victron product with 4 units in Xero and 648 units at Victron displays:

```text
4 in stock (KZN)
Availability: 3-5 working days
648 in stock at Victron Warehouse ZA
```

Do not run this every five minutes. Xero has daily request limits, and local stock does not need supplier-style refresh frequency. Use a 30-60 minute timer for local stock, with a future admin "Sync now" action if operators need an immediate refresh.

## Xero OAuth setup

Xero uses OAuth 2.0 rather than a static API key. Create a Xero Web App with this redirect URI:

```text
https://oc.sensible.co.za/api/xero/callback
```

Configure these environment variables on the VPS:

```bash
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=https://oc.sensible.co.za/api/xero/callback
XERO_TOKEN_FILE=/var/lib/thanda-store/xero-token.json
XERO_CONNECT_SECRET=<random admin-only secret>
```

Then visit:

```text
https://oc.sensible.co.za/api/xero/connect?secret=<XERO_CONNECT_SECRET>
```

Approve access to the correct Xero organisation. The callback stores the rotating refresh token and selected tenant in `XERO_TOKEN_FILE` with file mode `0600`.

Current scopes are `offline_access accounting.settings.read accounting.contacts.read`. Item stock sync uses settings read access. Contact read access is for linking store organisations to Xero contacts. Admin users can reconnect Xero from `/admin/users`; the admin route avoids exposing `XERO_CONNECT_SECRET` in the browser.

Draft quote creation will need a write-capable Xero scope. Do not add that scope back blindly if Xero returns `invalid_scope`; verify the accepted scope against the current Xero app configuration before deploying quote creation.

## Database

The app expects a PostgreSQL database with a `products` table. Apply the setup SQL with:

```bash
psql "$DATABASE_URL" -f db/products.sql
```

The sync job also creates or extends the required table defensively before writing products. Products are keyed by `(supplier, sku)` so multiple supplier lines can safely share the catalogue.

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

## Victron sync

Run a lightweight Victron price/stock sync:

```bash
cd thanda-store
npm run sync:victron
```

The Victron sync:

1. Reads `data/victron-zar-2026-q3-skus.json`.
2. Fetches `/api/v1/products/?format=json` from the Victron E-Order API.
3. Filters the API result to only SKUs present in the South Africa ZAR price list.
4. Uses `all_stock_by_warehouse.af_sa_inzuzo` when available for South Africa warehouse stock.
5. Stores the Victron account price as distributor cost and calculates recommended retail excluding VAT as `price / VICTRON_THANDA_DISCOUNT_FACTOR`.
6. Upserts PostgreSQL records keyed by `(supplier, sku)` with `supplier = 'victron'`.

Images and documents come from the heavier `/api/v1/products-extended/<SKU>/` endpoint. Run this intentionally, not every five minutes:

```bash
cd thanda-store
npm run sync:victron:extended
```

For scheduled syncs, use:

```bash
cd thanda-store
npm run sync:all
```

This runs Renogy and the lightweight Victron sync. A separate daily timer can run `sync:victron:extended` if product images and documents need routine refreshes.

### Quarterly Victron PDF update

Each quarter, replace the Victron South Africa allow-list from the new ZAR PDF price list. The PDF controls which Victron SKUs are listed in the store; live price and stock still come from the E-Order API.

1. Save the new Victron South Africa ZAR price-list PDF somewhere local, for example `~/Downloads/Pricelist_Victron_SAR_2026-Q4_Web.pdf`.
2. Regenerate the allow-list:

```bash
cd thanda-store
PYTHON=/Users/warwick/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  npm run extract:victron-allowlist -- \
  ~/Downloads/Pricelist_Victron_SAR_2026-Q4_Web.pdf \
  data/victron-zar-2026-q4-skus.json
```

3. Review the generated `skuCount` and spot-check a few rows against the PDF.
4. Update `VICTRON_ALLOWLIST_FILE` in the VPS sync environment if the output filename changed, or overwrite the existing `data/victron-zar-2026-q3-skus.json` if you want the code path to stay fixed.
5. Run `npm run sync:victron` to import the new active SKU set, then run `npm run sync:victron:extended` only if images/documents need refresh.
6. Commit the new allow-list and README/changelog note with the quarter and SKU count.

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
