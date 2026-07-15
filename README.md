# Thanda Store

Dealer inventory portal for Thanda Store. The repository contains a Next.js B2B storefront, PostgreSQL-backed catalogue, supplier/Xero synchronization jobs, and a small internal user administration area.

The root README is the operational source of truth. [`thanda-store/README.md`](thanda-store/README.md) is intentionally brief and points here.

## Repository layout

- `thanda-store/` - Next.js application for the dealer portal.
- `thanda-store/scripts/sync-renogy-products.mjs` - warehouse-driven Renogy sync job.
- `thanda-store/scripts/sync-victron-products.mjs` - Victron E-Order sync job filtered to the South Africa ZAR price-list SKUs.
- `thanda-store/scripts/sync-xero-stock.mjs` - Xero local/KZN stock sync for Victron and selected Thanda-owned products.
- `thanda-store/scripts/sync-xero-contact-access.mjs` - Reconciles enabled Xero primary/additional people and archives portal access removed in Xero.
- `thanda-store/scripts/sync-xero-sales-history.mjs` - Caches eligible Xero sales invoice SKU lines for Home favourites.
- `thanda-store/scripts/process-xero-webhook-events.mjs` - Processes verified Xero Invoice and Contact webhook events from the durable local queue.
- `thanda-store/scripts/generate-product-thumbnails.mjs` - batch thumbnail generator for supplier product images.
- `thanda-store/scripts/extract-victron-allowlist.mjs` - helper to regenerate the Victron South Africa SKU allow-list from a quarterly PDF price list.
- `thanda-store/scripts/seed-product-overrides.mjs` - manual product metadata and placeholder seed script for hidden categories, voltage notes, and non-API product lines.
- `thanda-store/data/victron-zar-2026-q3-skus.json` - generated Victron South Africa allow-list from the Q3 2026 ZAR price list.
- `db/products.sql` - PostgreSQL table setup for product data.
- `sync_db.js` - legacy CSV import helper.
- `sync_renogy_inventory.py` - experimental Renogy enrichment script.
- `renogy_*` scripts - supplier-specific authentication/API experiments.

## Architecture

- **Storefront:** Next.js application in `thanda-store/`, served by PM2 behind Nginx at `https://oc.sensible.co.za`.
- **Catalogue:** PostgreSQL `products` records keyed by `(supplier, sku)`. Product details that do not belong in first-class columns are stored in the JSONB `details` field.
- **Supplier stock and pricing:** Renogy and Victron scripts refresh supplier information. The store never derives a buyer price from a supplier/distributor cost.
- **Local KZN stock:** Xero Items refresh `details.localStockOnHand` for Victron products and the LoRa placeholder.
- **Authentication:** Email/password plus a Resend-delivered email OTP. Email is the sole portal login identifier. Each buyer organisation must be linked to a Xero contact before a buyer can log in.
- **Images:** Original supplier image URLs remain in PostgreSQL. The first catalogue response that finds a missing thumbnail starts background WebP generation; the current response falls back to the supplier original.

Generated local data files such as CSV exports, Excel reports, `node_modules`, and Next.js build output are intentionally ignored.

## External API discipline

Supplier, accounting, and messaging APIs are finite operational resources. The portal must serve normal user requests from PostgreSQL-derived data, never by calling a supplier or Xero during page rendering. Scheduled syncs must use provider batching, pagination, conditional/modified-since reads, and webhooks where appropriate. Where Xero supplies a webhook, it replaces routine polling; polling remains only a low-frequency reconciliation safety net.

Before changing an integration, document the expected calls per run and per day, the provider allowance, and the safety margin left for existing jobs and interactive administration. Respect `429` and `Retry-After`; persist rate-limit headers when available and pause locally through a daily-limit reset instead of repeatedly making rejected calls. Initial backfills must be resumable and bounded, not an unbounded one-request-per-record loop.

For Xero specifically, the current starter limit is 1,000 calls per tenant per day and 60 per minute. Xero does not provide an `InvoiceIDs` batch parameter on its invoice collection endpoint, so the webhook worker fetches changed invoices by their individual resource URL and caps itself at 20 queued invoices per run. It retains a 150-call daily reserve for stock, administration, and reconciliation. It records the latest allowance in `xero_api_usage`, and shows the cached value in User Admin. Do not add a live Xero call just to refresh this display. The five-minute webhook-worker timer makes no Xero request when the local queue is empty.

Every Xero integration change must be checked against the official [Xero OpenAPI 3 specification repository](https://github.com/XeroAPI/Xero-OpenAPI) before implementation. Follow Xero's [API Call Efficiencies guidance](https://developer.xero.com/documentation/getting-started-guide/) as a mandatory design rule: prefer webhooks where Xero supports them, cache derived portal data, use supported filters and `If-Modified-Since`, paginate deliberately, and retain a low-frequency reconciliation path. Do not invent request parameters or assume batch support; record the expected request count and allowance impact before deploying a changed Xero job.

## Local development

```bash
cd thanda-store
npm install
npm run dev
```

The app reads products from `GET /api/products`, which queries PostgreSQL through `src/lib/db.ts`.

## Command reference

Run commands from `thanda-store/`. Scheduled commands should not normally be run by hand; the intended use is noted below.

| Command | Purpose | When to run it |
| --- | --- | --- |
| `npm run sync:renogy` | Refresh Renogy catalogue, supplier stock, price and image metadata. | Manual troubleshooting only; `sync:all` runs it every five minutes on the VPS. |
| `npm run sync:victron` | Refresh allowed Victron products, supplier stock and prices. | After a new Victron allow-list, or manual troubleshooting; scheduled through `sync:all`. |
| `npm run sync:victron:extended` | Refresh Victron product images and documents from the slower extended endpoint. | After a new allow-list or when product media needs refreshing. Do not run every five minutes. |
| `npm run sync:all` | Run the Renogy and lightweight Victron syncs in sequence. | The VPS supplier-sync timer runs this every five minutes. |
| `npm run sync:xero-stock` | Refresh local/KZN stock from Xero Items. | Manual stock correction check only; the VPS runs it every 30 minutes. |
| `npm run sync:xero-contact-access` | Full reconciliation of enabled Xero-backed users removed from their linked Xero contact. | Daily safety net only; Contact webhooks normally handle changes. |
| `npm run sync:xero-sales-history` | Incrementally cache authorised/paid sales invoice SKU lines for Home favourites. | Daily safety net only; Invoice webhooks normally handle changes. |
| `npm run sync:xero-webhooks` | Process queued Xero Invoice/Contact webhook events. | VPS runs it every five minutes. It exits without a Xero call when the queue is empty. |
| `npm run images:thumbnails` | Generate missing WebP product thumbnails. | Exception/recovery use only. Normal thumbnail generation is automatic. |
| `npm run seed:product-overrides` | Apply display metadata and create the LoRa/Hubble placeholder products. | After a database rebuild or when intentionally reapplying product display rules. |
| `npm run extract:victron-allowlist -- <pdf> <output>` | Extract the SKU allow-list from a quarterly Victron ZAR PDF. | Once per new South Africa Victron price list. |
| `npm run start` | Start the production Next.js server. | PM2 owns this in production; use `npm run dev` locally instead. |
| `npm run lint` | Run ESLint. | Before committing frontend or API changes. |
| `npm run build` | Produce a production build. | Before deployment; the VPS build is the authoritative check. |

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
XERO_WEBHOOK_KEY=... # Xero Developer app webhook key; required by the PM2 Next.js process
DEFAULT_B2B_DISCOUNT_PERCENT=30
WAREHOUSE_CSV=/absolute/path/to/warehouse_inventory.csv
RESEND_API_KEY=re_...
OTP_FROM_EMAIL='Thanda Store <sales@thanda.solar>'
PORTAL_BASE_URL=https://oc.sensible.co.za
PRODUCT_THUMBNAIL_SIZE=600
PRODUCT_THUMBNAIL_IMAGE_BOX_SIZE=520
PRODUCT_THUMBNAIL_QUALITY=80
```

`DATABASE_URL` is preferred. `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` are also supported.
`RENOGY_PRODUCT_SOURCE` defaults to `export`; set it to `csv` only when deliberately testing with a local warehouse CSV.
`RENOGY_BEARER_TOKEN` is still supported as a bootstrap override, but production should use `RENOGY_EMAIL` and `RENOGY_PASSWORD` so the sync can refresh an expired token automatically. The refreshed token is cached in `RENOGY_TOKEN_CACHE_FILE` with file mode `0600`.
`VICTRON_EORDER_API_KEY` is required for Victron sync. The Victron API documentation recommends sending the key directly in the `Authorization` header; do not store it in source control.
`VICTRON_THANDA_DISCOUNT_FACTOR` defaults to `0.525`, meaning the Victron E-Order account price is Thanda's price after a 47.5% distributor discount from retail.
`XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` are OAuth app credentials from Xero. `XERO_CONNECT_SECRET` protects the one-off `/api/xero/connect` URL because API routes are not behind the storefront Basic Auth middleware. `XERO_WEBHOOK_KEY` is distinct from OAuth credentials and must be configured in the PM2 environment that serves Next.js, not only in the systemd worker environment.
`DEFAULT_B2B_DISCOUNT_PERCENT` is the fallback discount when a user has no supplier-specific discount. The API clamps it to a maximum of 40% off list price.
`RESEND_API_KEY` enables email OTP delivery through Resend. `OTP_FROM_EMAIL` defaults to `Thanda Store <sales@thanda.solar>`.
`PORTAL_BASE_URL` is the public portal URL used in account setup and password-reset emails. It defaults to `https://oc.sensible.co.za`.
`PRODUCT_THUMBNAIL_SIZE`, `PRODUCT_THUMBNAIL_IMAGE_BOX_SIZE`, and `PRODUCT_THUMBNAIL_QUALITY` control generated WebP framing. The defaults are appropriate for the current product cards; change them only when redesigning the image treatment.

## Pricing rules

The Renogy sync stores Renogy's unit price as Thanda's distributor cost. That value must never be displayed as the buyer price.

`GET /api/products` calculates buyer-facing prices from the supplier list price:

- `recommended_retail_ex_vat` is the internal field name for the supplier list price normalized to excluding VAT. The storefront labels it **List Price Excl. VAT**.
  - Renogy list price is treated as including VAT unless the sync marks it otherwise.
  - Victron South Africa list price is derived from the E-Order account price: `eorder_price / 0.525`. The PDF price list is used as the South Africa SKU allow-list, not as the pricing source. The raw Victron API retail field is kept in product details for comparison only.
- `your_price_ex_vat` = the list price less the configured B2B discount.
- B2B discount is capped server-side at 40%, even if environment configuration or user data asks for more.

All customer-facing prices in the portal are displayed excluding VAT.

Authenticated users can have supplier-specific discounts in `user_supplier_discounts`. Victron and Renogy discounts are capped at 40%. LoRa products do not receive a B2B discount; the Xero sales price is the buyer price.

## Portal users and OTP login

The storefront uses internal portal users with email OTP verification. Passwords are hashed in PostgreSQL and OTPs are stored as hashes with a short expiry.

Administrators manage users at `/admin/users`:

1. Search Xero by the buyer primary contact email and select the customer contact. The company name is read from Xero; it is not entered in the portal.
2. The portal emails a single-use account setup link that expires after seven days.
3. The buyer chooses their own password, then signs in with their email, password, and a short-lived email OTP.

The admin never sets, stores, or communicates the buyer password. **Send setup email** can be used to issue a new password-reset link. Disable an account to block future session checks without deleting its audit trail.

When an admin opens User Admin, each unlinked user is automatically checked with an exact Xero contact-email lookup. One active match is selected automatically; multiple exact matches are shown in a dropdown and require an explicit choice. **Find in Xero** remains available to retry a lookup or search the email entered in the invite form. The Contact ID and Contact Name fields remain available for manual correction or no-match cases.

After a Xero link is saved, User Admin shows a compact locked contact summary. Use **Edit Xero link** to deliberately reopen the linking fields; an unchanged saved link is not exposed as an editable form.

Changing a portal user email clears the organisation's Xero link, revokes that user's active sessions and outstanding codes, then reruns the automatic match against the new email. Because the Xero link belongs to the organisation, this affects every portal user in that organisation.

Xero is the source of truth for linked company names and eligible people. The portal stores the Xero Contact ID as identity and only caches the Xero Contact Name for display; Contact webhooks normally refresh that state and the daily contact-access job is a recovery reconciliation. The primary contact is the first portal login. User Admin can explicitly enable each Xero **Additional person**; it sends that person a setup email and applies the company discounts. It does not invite people automatically. If a previously enabled primary/additional person is removed from Xero (or the contact is archived), their portal account is archived, active sessions and outstanding codes are revoked, and access stops. Re-adding a person in Xero does not automatically restore access; an admin must explicitly re-enable them.

Buyer invitations require a Xero contact link. Non-admin users cannot complete login until their organisation is linked to Xero.

For email OTP, configure Resend:

```bash
RESEND_API_KEY=re_...
OTP_FROM_EMAIL='Thanda Store <sales@thanda.solar>'
PORTAL_BASE_URL=https://oc.sensible.co.za
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

Renogy products use two independently labelled fulfilment lines when both are available:

```text
Available now: n in stock (KZN)
Renogy Warehouse ZA: n in stock (4-7 working days)
```

Victron products use the equivalent wording with a 3-5 working day supplier lead time only when the E-Order South Africa warehouse quantity is positive:

```text
Available now: n in stock (KZN)
Victron Warehouse ZA: n in stock (3-5 working days)
```

When Victron ZA stock is zero, the portal displays `Victron Warehouse ZA: Out of stock / not available` and does not promise a lead time. The current E-Order product response exposes warehouse quantities but does not provide a reliable inbound-shipment ETA, so the portal must not infer one from the E-Order web interface.

Supplier-backed items with zero supplier stock and no KZN stock also show a diagonal red `Not available` card ribbon. The ribbon is suppressed when Thanda has KZN stock, because that item remains available immediately.

LoRa products are manufactured by Thanda, so they only display KZN stock. Hubble products currently use a manual availability string until an admin flip-control is added.

## Product image thumbnails

The storefront should not render supplier originals directly when a local thumbnail exists. Supplier images can be very large, inconsistently framed, or temporarily unavailable.

The authenticated catalogue API lazily queues thumbnail generation when it first encounters a product with an `image_url` but no local WebP. That request still uses the supplier image immediately, so browsing never waits for image processing; a later request uses the local WebP. The worker is detached from the request and retries a missing thumbnail at most once every five minutes per app process.

This is self-maintaining for normal product imports. No thumbnail timer or post-sync batch action is required. A newly imported product receives a thumbnail after the first authenticated catalogue load that includes it.

The batch command remains useful after a large import or when regenerating a changed source image:

```bash
cd thanda-store
npm run images:thumbnails
```

The thumbnail job:

1. Reads products with `image_url` from PostgreSQL, or specific products selected with `--id`.
2. Downloads supplier originals only when the local thumbnail is missing, unless `--force` is passed.
3. Writes normalized WebP files to `public/product-images/<supplier>/<sku>.webp`, served by the cached `/api/product-images/<supplier>/<sku>` media route.
4. Uses a white square canvas with padding so product cards have stable, mobile-friendly framing.

Useful targeted runs:

```bash
npm run images:thumbnails -- --supplier victron
npm run images:thumbnails -- --sku PMP482505012 --force
npm run images:thumbnails -- --id 123 --force
npm run images:thumbnails -- --limit 25
```

Use `--force` only after deliberately changing a source image or thumbnail settings. It overwrites the existing local WebP.

`GET /api/products` exposes `thumbnail_url` only when the local file exists. The storefront renders `thumbnail_url` first, falls back to the supplier `image_url`, then falls back to the placeholder icon. Local files are served through the cached public media route `/api/product-images/<supplier>/<sku>`. This keeps browsing resilient even if thumbnail generation misses a product.

## Home favourites and cart

Home is the first catalogue tab. **My favourites** ranks current visible catalogue SKUs from the linked Xero contact's authorised/paid sales invoices in the last 12 months. Repeat order count dominates, with a small 90/180-day recency boost. **Popular** is a simple global ranking by total units sold, so bulk sales are allowed to influence it.

Invoice history supplies only ranking. Cards always show the buyer's current price, stock and availability. Product codes no longer in the live catalogue simply do not appear. The cart stores SKU identity and quantity only; server-side APIs recalculate prices and supplier discounts when the cart is read and again immediately before Xero quote creation.

**Quote me!** creates an exclusive-VAT Xero draft quote against the linked contact. It sends the current list price with the appropriate line discount, including zero discount for LoRa. The cart clears only after Xero accepts the quote. It is not an order: acceptance, invoicing, credits and fulfilment are deliberately separate future workflow work.

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

For supplier-backed products, the storefront hides the KZN line when `localStockOnHand` is zero and continues to show the supplier warehouse line. For example, a Victron product with 4 units in Xero and 648 units at Victron displays:

```text
Available now: 4 in stock (KZN)
Victron Warehouse ZA: 648 in stock (3-5 working days)
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

Current scopes are `offline_access accounting.settings.read accounting.contacts.read accounting.invoices`. Item stock sync uses settings read access. Contact read access is for linking store organisations to Xero contacts and reconciling the primary contact plus Additional people. `accounting.invoices` permits the sales-history read cache and creation of draft quotes. Admin users can reconnect Xero from `/admin/users`; the admin route avoids exposing `XERO_CONNECT_SECRET` in the browser.

After a deploy that changes scopes, sign in as an administrator and use **Reconnect Xero** in User Admin. The connection status identifies any missing permission. Do not run sales-history sync or create quotes until `accounting.invoices` has been approved.

User Admin also shows the latest Xero API allowance observed by the sales-history sync: remaining daily and minute calls, when it was observed, and any recorded `Retry-After` deadline. Opening that page does not make an extra Xero request. If the daily allowance is exhausted, the timer records the reset deadline and later runs exit without calling Xero until then.

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

### VPS supplier schedule

The production supplier timer runs both the Renogy and lightweight Victron sync every five minutes. It is already enabled on the VPS; use the following unit names and paths when inspecting or rebuilding it.

The current supplier unit keeps its credentials in root-managed systemd environment values. Do not copy those values into documentation, shell history, or source control. Moving them into a root-readable `EnvironmentFile` is a worthwhile hardening task, but must be done as a coordinated server change.

`/etc/systemd/system/thanda-store-sync.service`:

```ini
[Unit]
Description=Sync Thanda Store products from Renogy

[Service]
Type=oneshot
WorkingDirectory=/root/thanda-store/thanda-store
# Configure DATABASE_URL and supplier credentials as root-readable environment values.
ExecStart=/usr/bin/npm run sync:all
```

`/etc/systemd/system/thanda-store-sync.timer`:

```ini
[Unit]
Description=Run Thanda Store supplier sync every five minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=thanda-store-sync.service

[Install]
WantedBy=timers.target
```

Enable it with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now thanda-store-sync.timer
systemctl list-timers thanda-store-sync.timer
journalctl -u thanda-store-sync.service -n 100 --no-pager
```

Five minutes is a reasonable starting point for supplier availability. If a supplier throttles or the run time approaches the interval, move to ten or fifteen minutes and add `last_updated` to the admin view.

### VPS Xero schedules and webhooks

Xero **Invoice CREATE/UPDATE** and **Contact CREATE/UPDATE** webhooks are the normal update path. `POST /api/xero/webhooks` HMAC-verifies the `x-xero-signature`, deduplicates events into `xero_webhook_events`, and immediately returns. The systemd webhook worker runs every five minutes, fetches only changed records, caps invoice work at 20 exact invoice-resource requests per run, and updates the derived invoice-history cache or linked-contact access. The worker does no Xero work when its queue is empty.

The sales-history and contact-access timers now run once per day as recovery reconciliation. They use cached state and `If-Modified-Since` for invoice history; they are not the normal freshness mechanism. Xero Items are not available as a webhook category, so the separate Xero local-stock timer continues every 30 minutes.

#### Configure the Xero webhook

Manage the Thanda Store Xero API integration at [Xero Developer app management](https://developer.xero.com/app/manage).

1. In the Xero Developer app, create a webhook subscription with endpoint `https://oc.sensible.co.za/api/xero/webhooks`.
2. Subscribe only to **Invoice** `CREATE` and `UPDATE`, and **Contact** `CREATE` and `UPDATE`.
3. Copy the Xero **Webhook Key** into the production PM2 environment as `XERO_WEBHOOK_KEY`, then restart PM2 with its environment refreshed. Do not put this value in Git or expose it in the admin UI.
4. Install and enable the worker unit below. The User Admin Xero panel confirms whether the web receiver key is present, but intentionally never displays it.

The endpoint returns `401` for an invalid signature and `503` if the queue/database is unavailable, which causes Xero to retry rather than losing an event. The queue is idempotent and a later event for the same invoice/contact fetches the current Xero record, not a stale event payload.

```bash
systemctl list-timers thanda-store-xero-stock.timer
systemctl list-timers thanda-store-xero-webhooks.timer
systemctl list-timers thanda-store-xero-contact-access.timer
systemctl list-timers thanda-store-xero-sales-history.timer
journalctl -u thanda-store-xero-stock.service -n 100 --no-pager
systemctl start thanda-store-xero-stock.service
systemctl start thanda-store-xero-webhooks.service
systemctl start thanda-store-xero-contact-access.service
systemctl start thanda-store-xero-sales-history.service
```

The tracked unit templates are in `deploy/systemd/`. Install the webhook worker and daily reconciliation timers with:

```bash
sudo install -m 0644 deploy/systemd/thanda-store-xero-webhooks.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-webhooks.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-contact-access.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-contact-access.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-sales-history.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-sales-history.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thanda-store-xero-webhooks.timer
sudo systemctl enable --now thanda-store-xero-contact-access.timer
sudo systemctl enable --now thanda-store-xero-sales-history.timer
```

## Deployment and operations

Production is hosted at `https://oc.sensible.co.za`.

- **Application checkout:** `/root/thanda-store`
- **Next.js working directory:** `/root/thanda-store/thanda-store`
- **Process manager:** PM2 process `thanda-store` (currently process id `0`)
- **Reverse proxy and TLS:** Nginx with the Certbot-managed `oc.sensible.co.za` certificate
- **Supplier timer:** `thanda-store-sync.timer`, every five minutes
- **Xero timer:** `thanda-store-xero-stock.timer`, every 30 minutes
- **Xero webhook worker:** `thanda-store-xero-webhooks.timer`, every five minutes, zero external calls when idle
- **Xero contact access timer:** `thanda-store-xero-contact-access.timer`, daily reconciliation
- **Xero sales-history timer:** `thanda-store-xero-sales-history.timer`, daily reconciliation after Xero invoice consent

Deploy a committed change from the VPS:

```bash
cd /root/thanda-store
git pull --rebase origin main
cd thanda-store
npm install
npm run build
pm2 restart thanda-store
pm2 save
```

Verify after deployment:

```bash
pm2 status thanda-store
curl -I https://oc.sensible.co.za/login
journalctl -u thanda-store-sync.service -n 50 --no-pager
journalctl -u thanda-store-xero-stock.service -n 50 --no-pager
```

Do not commit generated thumbnails, token files, credentials, `node_modules`, or Next.js build output. Product thumbnails are server-generated runtime data under `thanda-store/public/product-images/`.

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
4. Uses `all_stock_by_warehouse.af_sa_inzuzo` when available for South Africa warehouse stock. A zero quantity is `Out of stock / not available`; E-Order product responses currently do not supply a reliable inbound-shipment ETA.
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

## Known limitations and next operational work

- Draft quotes are intentionally not treated as orders. Quote acceptance, invoicing, credits, fulfilment, and quote-status syncing remain future workflow work.
- Hubble availability is still a manually seeded string; there is no administrator control for changing it.
- Supplier and Xero job failures are available in systemd logs, but no external alerting or admin sync-health view exists yet.
- A product thumbnail is generated after its first authenticated catalogue load. Use the batch thumbnail command after a bulk import when every thumbnail must be prepared before users browse.
- Credentials must stay in root-readable environment configuration and token files must remain mode `0600`. Rotate any secret that has ever been committed or shared outside its intended operational boundary.

See [CHANGELOG.md](CHANGELOG.md) for the production-facing change history.
