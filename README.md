# Thanda Store

Dealer inventory portal for Thanda Store. The repository contains a Next.js B2B storefront, PostgreSQL-backed catalogue, supplier/Xero synchronization jobs, and a small internal user administration area.

The root README is the operational source of truth. [`thanda-store/README.md`](thanda-store/README.md) is intentionally brief and points here.

For a developer-focused Xero implementation handoff, see [Xero Integration Handoff](docs/XERO_INTEGRATION_HANDOFF.md).

## Repository layout

- `thanda-store/` - Next.js application for the dealer portal.
- `thanda-store/scripts/sync-renogy-products.mjs` - warehouse-driven Renogy sync job.
- `thanda-store/scripts/sync-victron-products.mjs` - Victron E-Order sync job filtered to the South Africa ZAR price-list SKUs.
- `thanda-store/scripts/sync-xero-stock.mjs` - Xero local/KZN stock sync for Victron and selected Thanda-owned products.
- `thanda-store/scripts/sync-xero-contact-access.mjs` - Reconciles enabled Xero primary/additional people and archives portal access removed in Xero.
- `thanda-store/scripts/sync-xero-sales-history.mjs` - Caches net Xero customer sales by SKU: eligible sales invoices less eligible customer credit notes.
- `thanda-store/scripts/process-xero-webhook-events.mjs` - Processes verified Xero Invoice, Credit Note, and Contact webhook events from the durable local queue.
- `thanda-store/scripts/generate-product-thumbnails.mjs` - batch thumbnail generator for supplier product images.
- `thanda-store/scripts/extract-victron-allowlist.mjs` - helper to regenerate the Victron South Africa SKU allow-list from a quarterly PDF price list.
- `thanda-store/scripts/seed-product-overrides.mjs` - manual product metadata and placeholder seed script for hidden categories, voltage notes, and non-API product lines.
- `thanda-store/data/victron-zar-2026-q3-skus.json` - generated Victron South Africa allow-list from the Q3 2026 ZAR price list.
- `db/products.sql` - PostgreSQL table setup for product data.
- `sync_db.js` - legacy CSV import helper.
- `sync_renogy_inventory.py` - experimental Renogy enrichment script.
- `renogy_*` scripts - supplier-specific authentication/API experiments.

## Architecture

- **Storefront:** Next.js application in `thanda-store/`, served by PM2 behind Nginx at `https://store.thanda.solar`.
- **Catalogue:** PostgreSQL `products` records keyed by `(supplier, sku)`. Product details that do not belong in first-class columns are stored in the JSONB `details` field.
- **Supplier stock and pricing:** Renogy and Victron scripts refresh supplier information. The store never derives a buyer price from a supplier/distributor cost.
- **Local KZN stock:** Xero Items refresh `details.localStockOnHand` for Victron products and the LoRa placeholder.
- **Victron inbound stock:** The hourly E-Order job reads the Shipments and Backorders APIs and stores a local, transient planning snapshot. Billed invoice quantities create or extend expected inbound orders; E-Order status never confirms receipt. Administrators physically count deliveries and use **Confirm all** or **Confirm partial**. Receipt requests the existing debounced Xero Items reconciliation but never writes KZN stock directly. Shipment references containing `RMA` are excluded.
- **Victron replenishment:** `/admin/replenishment` uses only local PostgreSQL data: cached Xero sales over 30 and 90 days, Xero-sourced KZN stock, unreceived inbound quantities, current Victron backorders, configured minimum stock levels, and an optional provisional E-Order cart. It groups replacement SKU families and recommends the current SKU using the higher daily demand rate, a 5-day supplier lead time, 2 days of safety stock, and a 14-day target cover. Backorder quantities already represented by an open inbound balance on the same order and SKU family are not counted twice. The cart remains a replaceable HTML upload because E-Order exposes no cart API.
- **Victron stock minima:** `/admin/victron-stock-minima` is the ongoing maintenance screen for minimum KZN stock by current Victron SKU. The initial positive levels were seeded once from the Victron stock-sheet workbook; values are thereafter maintained here, rather than by recurring spreadsheet import.
- **Authentication:** Email/password plus a Resend-delivered email OTP. Email is the sole portal login identifier. Each buyer organisation must be linked to a Xero contact before a buyer can log in. A buyer can request a new one-use password setup link from `/forgot-password`.
- **Customer accounts:** `/accounts` serves company-scoped quotes, invoices and credit notes from a local Xero document snapshot. It never exposes Xero public links or documents belonging to another Xero contact. PDFs are fetched only after the current portal user's linked Contact ID has been checked.
- **Images:** Original supplier image URLs remain in PostgreSQL. The first catalogue response that finds a missing thumbnail starts background WebP generation; the current response falls back to the supplier original.

Generated local data files such as CSV exports, Excel reports, `node_modules`, and Next.js build output are intentionally ignored.

## External API discipline

Supplier, accounting, and messaging APIs are finite operational resources. The portal must serve normal user requests from PostgreSQL-derived data, never by calling a supplier or Xero during page rendering. Scheduled syncs must use provider batching, pagination, conditional/modified-since reads, and webhooks where appropriate. Where Xero supplies a webhook, it replaces routine polling; polling remains only a low-frequency reconciliation safety net.

Before changing an integration, document the expected calls per run and per day, the provider allowance, and the safety margin left for existing jobs and interactive administration. Respect `429` and `Retry-After`; persist rate-limit headers when available and pause locally through a daily-limit reset instead of repeatedly making rejected calls. Initial backfills must be resumable and bounded, not an unbounded one-request-per-record loop.

For Xero specifically, the current starter limit is 1,000 calls per tenant per day and 60 per minute. Xero does not provide an `InvoiceIDs` batch parameter on its invoice collection endpoint, so the webhook worker fetches changed invoices by their individual resource URL and caps itself at 20 queued invoices per run. It retains a 150-call daily reserve for stock, administration, and reconciliation. It records the latest allowance in `xero_api_usage`, and shows the cached value in Admin Settings. Do not add a live Xero call just to refresh this display. The five-minute webhook-worker timer makes no Xero request when the local queue is empty.

Every update to the current allowance also appends a row to `xero_api_usage_log`, retaining the call source and returned allowance headers for diagnosis. This is the operational audit trail for Xero call volume; use it to investigate consumption rather than infer it from the single current-usage row. Customer-account reads, including PDFs, stop before the protected daily reserve is crossed.

`thanda-store-xero-allowance-monitor.timer` reads that local ledger every five minutes and writes `/root/thanda-store/runtime/CODEX_ALERTS.md`. It makes no Xero request. Every Codex production Xero task must read this file before a deploy, recovery, manual sync, or investigation; `WARNING` and `CRITICAL` block non-essential Xero work until investigated.

Customer Accounts uses separate per-contact document snapshots. The first view imports a bounded full snapshot. Later stale or permitted manual refreshes request only Quotes, Invoices and Credit Notes changed since the last successful snapshot using Xero's `If-Modified-Since` header, then upsert those records locally. This preserves historical documents without re-reading them on each account view. A status update such as `SENT` to `INVOICED`, or back to a current status, is therefore reflected in the relevant tab after the next incremental refresh. Requests are sequential, paged deliberately, and spaced by at least 1.1 seconds. A successful snapshot is valid for six hours; manual refreshes are server-limited to one per 30 minutes per contact. Account reads stop before the shared Xero allowance falls below the retained operational reserve. Account listing views, PDF document views, statement downloads, and quote acceptance/unacceptance are written to `portal_activity_log`.

Every Xero integration change must be checked against the official [Xero OpenAPI 3 specification repository](https://github.com/XeroAPI/Xero-OpenAPI) before implementation. OAuth scope selection and validation must use only Xero's official [OAuth 2.0 scopes reference](https://developer.xero.com/documentation/guides/oauth2/scopes/); never infer a scope from historic tokens, OAuth errors, SDK constants, OpenAPI annotations, or examples. Follow Xero's [API Call Efficiencies guidance](https://developer.xero.com/documentation/getting-started-guide/) as a mandatory design rule: prefer webhooks where Xero supports them, cache derived portal data, use supported filters and `If-Modified-Since`, paginate deliberately, and retain a low-frequency reconciliation path. Do not invent request parameters or assume batch support. Every new or changed API feature requires a documented budget: request paths, cold-cache/backfill cost, scheduled daily cost, retry behaviour, cache invalidation source, reserve impact, and stop threshold. Unbounded customer-triggered API work must be redesigned before deployment. The local Xero usage ledger records response allowance headers by source and Admin Settings displays the daily breakdown without consuming Xero allowance.

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
| `npm run sync:renogy` | Refresh Renogy catalogue, supplier stock, price and image metadata. | The VPS runs it every five minutes. |
| `npm run sync:victron` | Refresh allowed Victron products, supplier stock and prices. | Full paginated read every four hours; persistent schedule and cooldown gates also apply to CLI runs. |
| `npm run sync:victron-orders` | Refresh E-Order shipment invoices and the transient backorder snapshot. | Independent hourly timer; Admin manual attempts have a five-minute interval. |
| `npm run sync:victron:scheduled` | Legacy sequential wrapper. | Not used by production timers; use the independent services. |
| `npm run sync:victron:extended` | Refresh Victron product images and documents from the slower extended endpoint. | After a new allow-list or when product media needs refreshing. Do not run every five minutes. |
| `npm run sync:all` | Run the Renogy and lightweight Victron syncs in sequence. | Manual recovery only. Production uses separate timers to protect Victron's API allowance. |
| `npm run sync:xero-stock` | Refresh local/KZN stock from Xero Items. | Manual stock correction check only; the VPS runs it every 30 minutes. |
| `npm run sync:xero-accepted-quotes` | Replace the cached snapshot of current accepted Xero quote reservations. | Manual recovery only; production runs it after the 30-minute stock sync. |
| `npm run sync:xero-planning` | Refresh Xero stock and accepted quote reservations sequentially. | Production 30-minute planning timer. |
| `npm run sync:xero-stock -- --if-requested` | Refresh local/KZN stock only when an Invoice webhook requested it. | VPS runs it every five minutes; it makes no Xero request when no request is pending. |
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
RENOGY_TOKEN_CACHE_FILE=/var/lib/thanda-store/renogy-token.json
RENOGY_PRODUCT_SOURCE=export
VICTRON_EORDER_API_KEY=...
VICTRON_THANDA_DISCOUNT_FACTOR=0.525
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=https://store.thanda.solar/api/xero/callback
XERO_TOKEN_FILE=/var/lib/thanda-store/xero-token.json
XERO_CONNECT_SECRET=...
XERO_WEBHOOK_KEY=... # Xero Developer app webhook key; required by the PM2 Next.js process
DEFAULT_B2B_DISCOUNT_PERCENT=30
WAREHOUSE_CSV=/absolute/path/to/warehouse_inventory.csv
RESEND_API_KEY=re_...
OTP_FROM_EMAIL='Thanda Store <sales@thanda.solar>'
PORTAL_BASE_URL=https://store.thanda.solar
PRODUCT_THUMBNAIL_SIZE=600
PRODUCT_THUMBNAIL_IMAGE_BOX_SIZE=520
PRODUCT_THUMBNAIL_QUALITY=80
```

`DATABASE_URL` is preferred. `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` are also supported.
`RENOGY_PRODUCT_SOURCE` defaults to `export`; set it to `csv` only when deliberately testing with a local warehouse CSV.
Renogy production authentication uses the cached bearer token in `RENOGY_TOKEN_CACHE_FILE`, protected with file mode `0600`. The five-minute Renogy sync acts as the keepalive. Do not configure or store a Renogy username or password on the VPS: portal login requires an email OTP and must remain an intentional operator action. If Renogy rejects the cached token, the sync stops with a clear authentication error until an operator completes the portal login and securely replaces the cached token.
`VICTRON_EORDER_API_KEY` is required for Victron sync. The Victron API documentation recommends sending the key directly in the `Authorization` header; do not store it in source control.
`VICTRON_THANDA_DISCOUNT_FACTOR` defaults to `0.525`, meaning the Victron E-Order account price is Thanda's price after a 47.5% distributor discount from retail.
`XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` are OAuth app credentials from Xero. `XERO_CONNECT_SECRET` protects the one-off `/api/xero/connect` URL because API routes are not behind the storefront Basic Auth middleware. `XERO_WEBHOOK_KEY` is distinct from OAuth credentials and must be configured in the PM2 environment that serves Next.js, not only in the systemd worker environment.
`DEFAULT_B2B_DISCOUNT_PERCENT` is the fallback discount when a user has no supplier-specific discount. The API clamps it to a maximum of 40% off list price.
`RESEND_API_KEY` enables email OTP delivery through Resend. `OTP_FROM_EMAIL` defaults to `Thanda Store <sales@thanda.solar>`.
`PORTAL_BASE_URL` is the public portal URL used in account setup and password-reset emails. It defaults to `https://store.thanda.solar`.
`PRODUCT_THUMBNAIL_SIZE`, `PRODUCT_THUMBNAIL_IMAGE_BOX_SIZE`, and `PRODUCT_THUMBNAIL_QUALITY` control generated WebP framing. The defaults are appropriate for the current product cards; change them only when redesigning the image treatment.

## Catalogue categories and filters

The desktop catalogue has a left category sidebar with counts; mobile uses **Categories & filters** to open a keyboard-accessible drawer. The selected category, result count, and removable filter chips stay above the products. **All categories** searches across the selected brand. Changing category clears specification filters; changing brand clears all filters. Search clears the category and specification filters, retaining any selected availability. Counts beside categories are the search matches before specification/availability filters, so an empty filtered result never hides another category.

Category filters cover inverter/charger range, battery voltage, AC voltage and power; solar-charger battery voltage, charge current and maximum PV voltage; cable/adapter/connector type, family, cable length and conductor size; battery voltage and capacity; and solar-panel power and rigid/flexible construction. Only attributes present in the current category's data are offered. Multiple values in one filter mean **any of these**; different filters must **all** match. A multi-voltage product appears under each explicitly recorded compatible voltage. Unknown values remain unset and do not match a selected specification. Power keeps watts and VA distinct; no conversion is inferred.

**Thanda stock** reads cached `details.localStockOnHand`; **Supplier stock** reads `stock_on_hand` (or Hubble's existing manually maintained in-stock statement); **Unavailable** means the relevant sources confirm no stock; missing or untracked stock appears under **Stock unknown**. A product stocked in both locations matches both filters. LoRa uses local stock only. With no availability filter selected, all catalogue products are discoverable, including unavailable products; the existing cart eligibility rules remain in force. Home favourites retain their existing Show/Hide unavailable control.

Supplier syncs persist `details.catalogueAttributes`, `details.catalogueAttributeSources`, `details.catalogueClassification` and `details.catalogueMeasurements`. Cached `technicalData` with exact supported specification labels and unit-bearing values takes precedence over conservative product-name parsing. Both a label-to-value object and entries with `name`/`label` and `value` are supported; unfamiliar supplier formats remain unparsed. Lightweight syncs retain previously cached extended specifications. Renogy's currently stored product names provide the battery/panel fallbacks; the sync does not fetch extra product specifications. Attribute values are exposed as `catalogue_attributes` in the existing protected catalogue response; raw source metadata stays server-side.

Customer-facing classification uses stored supplier subcategories and conservative product-name rules. It separates **Solar panels**, **Cables & connectors** and **Other accessories** without rewriting `products.category` or `details.subcategory`. The protected catalogue response includes the original `supplier_category` separately from its display `category`; Renogy eligibility still uses that original category. Specific mixed groups are checked for the sold item: a battery monitor stays a monitor, a mounting adapter is an accessory, and an antenna does not inherit the length of its included cable. Uncertain products keep their supplier grouping and receive no guessed specifications.

Cable length is stored as numeric metres in `details.catalogueMeasurements.cableLengthM`; conductor area is numeric square millimetres in `conductorSizeMm2`. Display/filter values use **Cable length** and **Conductor size**. `0,3m`, `0.3 m`, `30cm` and `300mm` all mean 0.3 m; `1,8 m` means 1.8 m. Ranges, fractions, multiple different lengths, unsupported units and ambiguous dimensions remain unset. Panel dimensions never become cable measurements. Cable families recognize VE.Direct, RJ12/RJ45, VE.Can–BMS types A/B, solar and shore-power connections. Manufacturer/supplier specifications override name parsing; reviewed exceptions override both.

A per-product `details.catalogueOverride` may contain `kind` (`cable`, `adapter`, `connector`, `panel`, `battery`, `inverter`, `charger`, `accessory`, `other`), `cableLengthM` and/or `conductorSizeMm2`. A non-empty `reason` recording the review evidence is mandatory. Measurements must be positive numbers, or `null` to explicitly suppress a measurement. For example: `{"kind":"cable","cableLengthM":0.3,"reason":"Checked packaging and manufacturer specification"}`. This is deliberately a small data correction mechanism, not a new admin editor. Update the reviewed product's JSONB key locally, then run the backfill; ordinary supplier syncs merge their fields while retaining the override. Removing an override and rerunning backfill restores supplier/name derivation.

Before changing classification rules, review a local metadata-only snapshot (`sku`, `supplier`, `name`, `category`, `details.subcategory`, `technicalData`, existing catalogue metadata, `catalogueOverride`, and `hidden`):

```bash
node scripts/review-catalogue-classification.mjs /path/to/snapshot.json /path/to/review.md
```

The report includes every category move, old/new cable measurements and unresolved classifications. Review movements as well as unchanged uncertain products before running a production write. The [2026-09-25 review](docs/catalogue-classification-review.md) records the current cleanup and retained uncertainties. Neither reporting nor backfill fetches supplier data.

Reviewed name patterns include explicit voltage/capacity/power/length units, MultiPlus/Quattro model battery voltage and VA ratings, and SmartSolar/BlueSolar MPPT PV-voltage/current pairs. MPPT battery compatibility is **never** inferred from the model pair: it requires explicit labelled compatibility or a supplier specification. Accessories and kits do not inherit the host product's ratings. Manufacturer references: [MultiPlus-II specifications](https://www.victronenergy.com/media/pg/MultiPlus-II_230V/en/technical-specifications-mp-ii-230v.html) and [SmartSolar model ratings](https://www.victronenergy.com/media/pg/Manual_SmartSolar_MPPT_100-30__100-50/en/introduction.html). The 450 V filter also covers SmartSolar MPPT RS 450/100 and 450/200, plus the solar-equipped Multi RS and Inverter RS 48/6000 models. Their manufacturer-rated maximum is recorded from [MPPT RS specifications](https://www.victronenergy.com/media/pg/SmartSolar_MPPT_RS/en/technical-specifications.html), [Multi RS Solar specifications](https://www.victronenergy.com/media/pg/Multi_RS_Solar/en/technical-specifications.html), and [Inverter RS Smart Solar specifications](https://www.victronenergy.com/media/pg/Inverter_RS_Smart_Solar/en/technical-specifications.html). The non-solar Inverter RS Smart and accessories do not receive a PV-input rating. Each saleable predecessor/current SKU keeps its own attributes; no succession map is duplicated. The filter records a catalogue rating, not a PV string-design limit; the manufacturer's installation constraints still apply. Parser changes need representative positive and ambiguous/negative fixtures in `test/catalogue-filters.test.mjs`.

Existing records use the same local derivation until stored attributes exist. To persist attributes without a supplier sync, run from `thanda-store/` with the normal database environment:

```bash
npm run backfill:catalogue-attributes             # dry run
npm run backfill:catalogue-attributes -- --write # persist local attributes
npm run test:catalogue-filters
```

The backfill scans 250 records per batch, is restartable, and changes only derived attribute, provenance, classification and measurement JSON. Concurrently changed records are skipped and can be picked up on the next run. It does not change stock, pricing or supplier observation timestamps. Catalogue discovery works on each existing saleable SKU row; it does not aggregate successor-family stock or copy predecessor specifications. The existing `victron_sku_successions` image fallback and fulfilment/planning family resolution remain authoritative in their respective workflows.

**API budget:** filtering, drawer/category changes and the backfill make **zero supplier or Xero calls per action/run/day**. Extraction reuses each scheduled sync's existing responses and one local PostgreSQL metadata read per upsert; provider endpoints, schedules, quotas, reserves, timeouts, retry/429 handling and stop thresholds are unchanged. Existing extended specifications are reused without triggering the extended endpoint. Attributes are replaced when the normal catalogue sync updates a product, or by the local backfill after a parser change. There is no external cold-cache fill, customer-triggered refresh, or new polling loop.

## Pricing rules

The Renogy sync stores Renogy's unit price as Thanda's distributor cost. That value must never be displayed as the buyer price.

`GET /api/products` calculates buyer-facing prices from the supplier list price:

- `recommended_retail_ex_vat` is the internal field name for the supplier list price normalized to excluding VAT. The storefront labels it **List Price Excl. VAT**.
  - Renogy product-detail `originalPrice` is the list price excluding VAT. The partner portal displays that value including VAT. The sync stores this explicitly as `recommendedRetailExVat` with `recommendedRetailPriceVatMode: ex_vat`; `unitPrice` remains Thanda's distributor cost and is never shown to buyers.
  - Victron South Africa list price is derived from the E-Order account price: `eorder_price / 0.525`. The PDF price list is used as the South Africa SKU allow-list, not as the pricing source. The raw Victron API retail field is kept in product details for comparison only.
- `your_price_ex_vat` = the list price less the configured B2B discount.
- B2B discount is capped server-side at 40%, even if environment configuration or user data asks for more.

All customer-facing prices in the portal are displayed excluding VAT.

Supplier-specific discounts belong to the linked Xero contact in `contact_supplier_discounts`, so every user in a company sees the same prices. **Admin → Companies** owns company pricing; the individual user editor owns API access. Victron and Renogy discounts are capped at 40%. LoRa products do not receive a B2B discount; the Xero sales price is the buyer price.

## Stock freshness and data health

The storefront shows product-level availability without a global source-health panel. Operational source status belongs in **Admin → Data health**. Source observation times are not page-load or local import times. Stock whose quantity or observation is missing remains **unknown**; confirmed zero remains zero. Xero missing/untracked items are unknown rather than zero. Hubble availability is explicitly manual, and LoRa has only Thanda stock. The **Stock unknown** filter keeps uncertain products discoverable without labelling them unavailable. Catalogue and favourites failures have their own Retry message and never masquerade as empty search results.

**Admin → Data health** (`/admin/data-health`) lists incomplete, overdue or failed sources first. It shows the oldest retained observation, latest local attempt/success and counts of missing or overdue records. **Check status** rereads the local records only. Failure messages are bounded categories, not provider response bodies. Supplier, stock and sales jobs persist one outcome row per source in `data_sync_status`; failed/partial updates retain the previous successful evidence. Existing order and accepted-quote state is reused.

Each problem source includes **What to do**, relevant navigation and a **Download diagnostic report** action. **Review affected SKUs** searches stored item-level evidence and distinguishes missing Xero items, untracked inventory, missing observations and overdue quantities, with a resolution for each cause. Correct Xero item/tracking problems with the bookkeeper; persistent feed or mapping problems go to the Store maintainer with the diagnostic report. Rate-limit guidance waits for the provider cooldown and scheduled retry. These tools add no upstream requests or new sync triggers.

**Review missing Xero items** provides a searchable queue, a reviewed view and Undo. **Do not stock** and **No longer supplied by Victron** acknowledge only the missing-Xero alert for the exact supplier/SKU. Retirement requires a reason; missing from Xero alone does not prove supplier retirement. The review displays the shared succession family, but never changes it, removes sales or stock, or fabricates a zero stock observation. Planning still withholds a quantity when it requires unknown stock. A later tracked or untracked Xero observation supersedes the acknowledgement. Reviews and their actor/timestamp audit events live in separate `product_stock_reviews` and `product_stock_review_events` tables, preserved across catalogue syncs.

**Add in Xero** opens Xero for the bookkeeper to configure the item and inventory accounts. The current Hub client exposes no item-creation command. **Check Xero item** reads `/Items` from the Hub's complete saved collection, validates its snapshot and source time, and imports that SKU's stock observation only if it is not older than the Store's current evidence. It distinguishes absent, untracked, missing-quantity and tracked results and reports the source observation time. Newly added items may take time to appear in the Hub. Checks share the stock import lock and have a global one-minute cooldown. Budget: one bounded Hub read per explicit check, at most one per minute, **zero direct Xero requests**, no provider retries, new schedules or backfill. Unavailable/incomplete Hub evidence leaves product stock unchanged. Admin authentication and same-origin checks protect all review mutations.

| Source | Warn when the source observation is older than |
| --- | --- |
| Renogy supplier stock | 20 minutes |
| Victron supplier stock; shipments/backorders | 3 hours |
| Thanda stock; accepted quote reservations | 2 hours |
| Sales and credit-note history | 36 hours |

These windows allow several scheduled runs; they are warning thresholds, not delivery or availability guarantees. Hubble manual availability has no automatic freshness promise. Sales history now retains the Hub's observation timestamps separately from import timestamps. Until its next normal successful sync, legacy history is reported as having unknown freshness. Status tables/columns are created by the normal jobs; status endpoints are read-only and treat absent evidence as unknown.

Replenishment keeps unknown quantities separate from zero across replacement families, including hidden predecessors and missing family members. Base and `R` packaging aliases count once. A missing required stock, sales, shipment/backorder or reservation observation withholds the suggested quantity and shows **Needs data**. Stale or failed sources with usable retained values keep both the calculation and the usual **Order / Top up / Partial / Satisfied / Covered** status. A separate warning icon opens a dialog with the reasons and links to Data health, without increasing table row height. Supplier freshness does not change the calculated target or order quantity. Overdue inbound and unmatched accepted-quote lines also require review. Unknown quantities sort last in either direction. No source is refreshed by opening the report.

Budget: data health, catalogue filtering and replenishment add **zero supplier, Hub or Xero calls per request**, including cold state and retries. Existing sync instrumentation adds zero provider calls per run/day, no backfill, no provider retries and no schedule change. Existing provider limits, cooldowns and reserves remain in force. Source timestamps and job outcomes change only on normal scheduled work; **Retry** retries a local read.

Validation: `node --test test/*.test.mjs` covers pure contracts. The company and freshness integration suites use isolated synthetic PostgreSQL schemas and a local fake Hub; see the commands in `docs/customer-commerce.md`. No real customer, supplier or accounting data is needed.

## Portal users and OTP login

The storefront uses internal portal users with email OTP verification. Passwords are hashed in PostgreSQL and OTPs are stored as hashes with a short expiry.

Administrators can view User Admin at `/admin/users`. The page shows a compact Xero connection indicator; **Admin → Settings** contains the global connection details, cached allowance and reconnect control. Any portal administrator can reconnect Xero because the integration is global; only an administrator with **Manage users** permission can invite people, alter roles or permissions, edit account setup, or enable and disable accounts. This avoids granting customer/account-management powers to every administrator. A user manager can create an internal administrator without a Xero customer contact; those internal accounts are kept in the local **Thanda staff** organisation. Buyer invitations remain linked to a Xero customer contact.

Administrators with **Manage users** manage company records at `/admin/companies` and people at `/admin/users`. The create forms sit above their respective lists. The Admin menu groups people and sales, stock and planning, and system settings in that order. Select **Edit** for a personal account page ordered by company, email, permissions, customer API access and account actions. Xero connection diagnostics remain in Settings. To onboard a buyer:

User Admin has **Add company** and **Add user** shortcuts that jump to the respective forms near the top of their pages. Its Xero tag shows the current connection check; open **Settings** for the full Xero allowance, reconnect action and quote creation control. The status check reads the Hub's stored state and makes no Xero API call. **API access** appears in the Store navigation for every signed-in user and under **Your account** in the Admin menu. The page shows the key controls and guide for enabled users, or explains that an administrator must enable access. The link in Edit user always opens the current administrator's own API access, not the edited person's keys.

User managers can select **View as** on an active buyer to work in that customer's store account for up to one hour. The banner identifies the buyer and acting administrator and has **Return to admin**. Cart changes and quote requests use the buyer's account, company discount and Xero Contact ID; quote notifications and the local activity log identify the acting administrator. The buyer receives the normal quote notification, with wording that Thanda created the request on their behalf. Customer view cannot grant another administrator's privileges or create/revoke the buyer's API keys. Starting, stopping and viewing use stored portal data only: zero supplier or Xero calls. A submitted quote uses the existing one Hub quote request and normal notification path; there is no additional provider request for customer view.

1. Open **Companies**, find the company in the Hub's stored Xero contacts by primary email, and set its discounts. Creating the company also creates its primary contact's buyer account and sends a single-use seven-day setup invitation. If the contact has no primary email, or that email already belongs to another Store user, creation stops without adding the company. The company name comes from Xero and its Contact ID stays fixed.
2. For a company already in the Store without a primary buyer, use **Invite primary contact** on its company card. For additional people, use **Add user** in User Admin or show the eligible Xero people on the company card and enable one. The email must belong to that contact's eligible primary/additional people. If sending fails after account creation, the page reports the failure and a user manager can resend from the user page.
3. The buyer chooses their own password, then signs in with their email, password and a short-lived email OTP. The verification step focuses the code field after each send, lets them resend after 30 seconds, and signs in automatically when a complete six-digit code is entered or pasted.

The admin never sets, stores or communicates the buyer password. For an active account without a pending setup link, User Admin exposes **Send password reset**. Buyers can also use **Forgot password?** on the sign-in page. It always returns the same confirmation regardless of account existence, and sends a new single-use seven-day setup link only for a login-eligible user. Reset emails are limited to one per account per minute. Disable an account to block future session checks without deleting its audit trail.

Changing a person's email validates it against the same company's eligible stored Xero people. It changes only that person, revokes their sessions, outstanding codes and API keys, and preserves the company link, discounts and colleagues' access. Invalid/duplicate email or unavailable Hub evidence leaves the account unchanged. Internal staff without a Xero contact remain individually editable.

Use **Move to another company** on the user page for an actual membership change. The destination must list that person's email as eligible; **Email at destination company** allows an email change in the same transaction. The transaction moves only that person, revokes their sessions/codes/keys, disables their API access and clears their personal cart; they use the destination company's pricing. Other members and company records are untouched. User managers must explicitly re-enable API access if appropriate. Company creation, price changes, email edits and membership moves are audited. Historical quotes stay associated with their original Xero contact. An organisation's Contact ID cannot be repointed through a user edit or a legacy relink request.

Xero remains the source of truth for company names and eligible people. The portal stores the Contact ID as identity and caches its name for display. The existing contact-access reconciliation updates names and archives portal access removed in Xero. Enabling a primary/additional person always requires an administrator; re-adding someone in Xero does not automatically restore access. Company pricing applies to every member; API access remains a separate per-person setting.

Company listing/pricing/movement bookkeeping reads and writes local PostgreSQL. Company creation, an explicit people lookup, invitations and email/membership validation reuse bounded stored-Hub contact reads, with no direct Xero calls, provider refresh, polling or retry. Company creation uses one stored contact read and one Resend email submission; inviting an existing company's primary contact uses at most two stored contact reads and one Resend email submission. These changes add **zero supplier/Xero calls per action or day**, including cold state, and do not alter the shared reserve or provider schedules. If Hub evidence cannot be validated, the change stops without updating the account.

Buyer invitations require a Xero contact link. Non-admin users cannot complete login until their organisation is linked to Xero.

For email OTP, configure Resend:

```bash
RESEND_API_KEY=re_...
OTP_FROM_EMAIL='Thanda Store <sales@thanda.solar>'
PORTAL_BASE_URL=https://store.thanda.solar
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

Victron description markers in the exact form `If 0, order <SKU>` create a local SKU-succession relationship. The old SKU remains its own card while it has stock. The named successor is a deliberate exception to the quarterly PDF allow-list and is synchronised as a current catalogue product. Invoice history for all family members is combined into one Home ranking, which selects the newest orderable SKU.

For fulfilment, the server resolves the family when a product is added to the cart and again immediately before creating its Xero quote. It uses the closest older SKU that has either KZN or Victron warehouse stock; if no older SKU has stock, it uses the newest SKU, because that is the SKU Thanda can procure from Victron. This is deliberately a server-side rule so it remains correct if stock changes between adding an item and checkout. Where multiple cart lines resolve to the same SKU, they are consolidated into one Xero quote line.

When a successor has no own supplier image or generated thumbnail, its card temporarily uses the predecessor's image or thumbnail. The fallback is evaluated on every catalogue read: as soon as the successor receives its own supplier image or local thumbnail, the predecessor image is no longer used. This avoids blank cards without retaining a copied image as permanent successor data.

Invoice history supplies only ranking. Cards always show the buyer's current price, stock and availability. Product codes no longer in the live catalogue simply do not appear. The cart stores SKU identity and quantity only; server-side APIs recalculate prices and supplier discounts when the cart is read, and apply Victron fulfilment SKU selection when an item is added and again immediately before Xero quote creation.

**Quote me!** creates an exclusive-VAT Xero draft quote against the linked contact. It sends the current list price with the appropriate line discount, including zero discount for LoRa. The cart clears only after Xero accepts the quote. It is not an order: acceptance, invoicing, credits and fulfilment are deliberately separate future workflow work.

## Customer accounts

Authenticated buyers can open **Accounts** from the store header. The view provides current and historical company-scoped Xero quotes, invoices and credit notes, with authenticated PDF retrieval. It has no public document links. A CSV statement download includes invoices and credit notes only; it is generated from the same protected, cached snapshot. Accounts returns 25 documents at a time, newest first. The **Newer** and **Older** controls page the local snapshot, while progressive partial search matches document number or reference without making a Xero request.

Only a Xero quote in `SENT` status can be accepted from the portal. An `ACCEPTED` quote can be marked unaccepted, which returns it to `SENT`; the portal never rewrites it to a draft. Both operations re-fetch the individual quote, verify it belongs to the logged-in company's Xero contact, then update the status and refresh the snapshot. Statements are generated from the protected local document snapshot, so the Accounts feature does not request an unused Xero Reports permission.

The Quotes tab offers **Copy to new quote**. It opens a review screen populated from the original quote's SKU lines. A retired Victron SKU is replaced only when the succession table identifies a live successor; live source SKUs remain unchanged. Buyers can change quantities, remove lines, and progressively search the current catalogue to add products. Saving recalculates the buyer's current price and supplier discount, re-applies the stock-aware Victron fulfilment rule, and creates a new Xero `DRAFT` quote only. The original quote is never changed.

The generic **Credit available** card is intentionally hidden for now. Xero's public Accounting API exposes Contact sales payment terms but not a contact credit-limit field, so any future credit-limit and payment-period values must be maintained explicitly in the portal rather than inferred from Xero.

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
https://store.thanda.solar/api/xero/callback
```

Configure these environment variables on the VPS:

```bash
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=https://store.thanda.solar/api/xero/callback
XERO_TOKEN_FILE=/var/lib/thanda-store/xero-token.json
XERO_CONNECT_SECRET=<random admin-only secret>
```

Then visit:

```text
https://store.thanda.solar/api/xero/connect?secret=<XERO_CONNECT_SECRET>
```

Approve access to the correct Xero organisation. The callback stores the rotating refresh token and selected tenant in `XERO_TOKEN_FILE` with file mode `0600`.

Current scopes are `offline_access accounting.settings.read accounting.contacts.read accounting.invoices`. Item stock sync uses settings read access. Contact read access is for linking store organisations to Xero contacts and reconciling the primary contact plus Additional people. `accounting.invoices` permits the sales-history read cache, draft-quote creation, and authenticated quote, invoice, and credit-note PDF retrieval. Admin users can reconnect Xero from `/admin/settings`; the admin route avoids exposing `XERO_CONNECT_SECRET` in the browser.

After a deploy that changes scopes, sign in as an administrator and use **Reconnect Xero** in Settings. The connection status identifies any missing permission. Do not run sales-history sync, create quotes, or use document PDFs until `accounting.invoices` has been approved.

Settings shows the latest Xero API allowance observed by the Hub: remaining daily and minute calls, when it was observed, and any recorded `Retry-After` deadline. Opening that page does not make an extra Xero request. If the daily allowance is exhausted, the timer records the reset deadline and later runs exit without calling Xero until then.

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

### VPS supplier schedules

Renogy and Victron have different API characteristics and must not share one timer:

- `thanda-store-renogy-sync.timer` runs every five minutes.
- `thanda-store-victron-sync.timer` runs the catalogue every four hours (UTC 00/04/08/12/16/20). `thanda-store-victron-orders.timer` runs shipments/backorders independently every hour. Both use the PostgreSQL-backed Victron request controller; the old JSON cooldown is imported without shortening its deadline.

Both services load credentials from `/etc/thanda-store-supplier.env`, owned by `root:root` with mode `0600`. Never store supplier or database credentials in unit files, documentation, shell history, or source control.

`/etc/systemd/system/thanda-store-renogy-sync.service`:

```ini
[Unit]
Description=Sync Thanda Store Renogy catalogue and warehouse stock

[Service]
Type=oneshot
WorkingDirectory=/root/thanda-store/thanda-store
EnvironmentFile=/etc/thanda-store-supplier.env
ExecStart=/usr/bin/npm run sync:renogy
```

`/etc/systemd/system/thanda-store-renogy-sync.timer`:

```ini
[Unit]
Description=Run Thanda Store Renogy sync every five minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=thanda-store-renogy-sync.service

[Install]
WantedBy=timers.target
```

Enable it with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now thanda-store-renogy-sync.timer thanda-store-victron-sync.timer
systemctl list-timers 'thanda-store-*-sync.timer'
journalctl -u thanda-store-victron-sync.service -n 100 --no-pager
```

The Victron endpoint is a catalogue-wide paginated read, so a five-minute schedule repeatedly exhausts its allowance. Do not shorten the hourly timer without measuring page count and a sustained no-`429` run history.

### VPS Xero schedules and webhooks

Xero **Invoice CREATE/UPDATE** and **Contact CREATE/UPDATE** webhooks are the normal update path. `POST /api/xero/webhooks` HMAC-verifies the `x-xero-signature`, deduplicates events into `xero_webhook_events`, and immediately returns. The systemd webhook worker runs every five minutes, fetches only changed records, caps invoice work at 20 exact invoice-resource requests per run, and updates the derived invoice-history cache or linked-contact access. A processed customer-invoice event also writes a durable request for local stock refresh. The worker does no Xero work when its queue is empty.

Xero does not expose Quote webhooks, so accepted quote reservations use a bounded full snapshot. The 30-minute planning service fetches `Status=ACCEPTED` Quotes in pages of 100 immediately after the stock sync; with the current single page this is 48 calls per day. Additional pages add 48 calls per day each. Admin can request an immediate check from Replenishment, subject to a one-minute cooldown. Normal page loads use PostgreSQL only. RMA quotes and accepted quotes older than `XERO_ACCEPTED_QUOTE_RESERVATION_DAYS` (default 90) remain visible in summary counts but do not reserve stock. The full replacement snapshot is deliberate: a quote that leaves ACCEPTED must stop reserving stock without relying on an unavailable Quote webhook.

The sales-history and contact-access timers now run once per day as recovery reconciliation. They use cached state and `If-Modified-Since` for invoice history; they are not the normal freshness mechanism. Xero Items are not available as a webhook category, so local stock has two bounded paths: the invoice-triggered five-minute worker makes one full Xero Items request only when a customer invoice has changed, while the separate 30-minute timer remains the safety net for stock adjustments and other non-invoice changes. Both use a shared advisory lock and record the Xero allowance headers.

#### Configure the Xero webhook

Manage the Thanda Store Xero API integration at [Xero Developer app management](https://developer.xero.com/app/manage).

1. In the Xero Developer app, create a webhook subscription with endpoint `https://store.thanda.solar/api/xero/webhooks`.
2. Subscribe to **Invoice**, **Credit note**, and **Contact** `CREATE` and `UPDATE` events.
3. Copy the Xero **Webhook Key** into the production PM2 environment as `XERO_WEBHOOK_KEY`, then restart PM2 with its environment refreshed. Do not put this value in Git or expose it in the admin UI.
4. Install and enable the worker unit below. The Xero panel in Admin Settings confirms whether the web receiver key is present, but intentionally never displays it.

The endpoint returns `401` for an invalid signature and `503` if the queue/database is unavailable, which causes Xero to retry rather than losing an event. The queue is idempotent and a later event for the same invoice/contact fetches the current Xero record, not a stale event payload.

```bash
systemctl list-timers thanda-store-xero-stock.timer
systemctl list-timers thanda-store-xero-stock-webhook.timer
systemctl list-timers thanda-store-xero-webhooks.timer
systemctl list-timers thanda-store-xero-contact-access.timer
systemctl list-timers thanda-store-xero-sales-history.timer
journalctl -u thanda-store-xero-stock.service -n 100 --no-pager
systemctl start thanda-store-xero-stock.service
systemctl start thanda-store-xero-webhooks.service
systemctl start thanda-store-xero-contact-access.service
systemctl start thanda-store-xero-sales-history.service
```

The tracked unit templates are in `deploy/systemd/`. Install the stock, webhook, and daily reconciliation timers with:

```bash
sudo install -m 0644 deploy/systemd/thanda-store-xero-webhooks.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-webhooks.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-stock.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-stock.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-stock-webhook.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-stock-webhook.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-contact-access.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-contact-access.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-sales-history.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-sales-history.timer /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-allowance-monitor.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/thanda-store-xero-allowance-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now thanda-store-xero-webhooks.timer
sudo systemctl enable --now thanda-store-xero-stock.timer
sudo systemctl enable --now thanda-store-xero-stock-webhook.timer
sudo systemctl enable --now thanda-store-xero-contact-access.timer
sudo systemctl enable --now thanda-store-xero-sales-history.timer
sudo systemctl enable --now thanda-store-xero-allowance-monitor.timer
```

## Deployment and operations

Production is hosted at `https://store.thanda.solar`.

- **Application checkout:** `/root/thanda-store`
- **Next.js working directory:** `/root/thanda-store/thanda-store`
- **Process manager:** PM2 process `thanda-store`, running the Next.js entry point directly with file watching disabled
- **Reverse proxy and TLS:** Nginx with the Certbot-managed `store.thanda.solar` certificate
- **Supplier timers:** `thanda-store-renogy-sync.timer`, every five minutes; `thanda-store-victron-sync.timer`, every four hours; `thanda-store-victron-orders.timer`, hourly
- **Xero timer:** `thanda-store-xero-stock.timer`, every 30 minutes
- **Xero invoice-stock timer:** `thanda-store-xero-stock-webhook.timer`, every five minutes and no external call when no invoice refresh is pending
- **Xero webhook worker:** `thanda-store-xero-webhooks.timer`, every five minutes, zero external calls when idle
- **Xero contact access timer:** `thanda-store-xero-contact-access.timer`, daily reconciliation
- **Xero sales-history timer:** `thanda-store-xero-sales-history.timer`, daily reconciliation after Xero invoice consent

Deploy a committed change from the VPS with the guarded command:

```bash
cd /root/thanda-store
bash deploy/deploy-store.sh --check
bash deploy/deploy-store.sh
```

The command reads the local Xero health note, refuses dirty tracked source or a divergent Git history, and uses a lock to prevent overlapping deployments. It stops the Store while Next.js replaces `.next`, builds the fetched `origin/main` commit, restarts PM2, and verifies the login page and its CSS before removing the previous build. This creates a short planned interruption during the build rather than serving a half-built page. If the build or health check fails, it restores the previous commit and build and attempts to restart it. A changed lockfile uses `npm ci`; ordinary source changes do not reinstall dependencies. Runtime product images remain in place.

PM2 must run `node_modules/next/dist/bin/next start` directly with watch disabled. Running `npm run start` through a shell wrapper or enabling PM2 watch can leave an orphaned Next process on port 3000 when a build changes files. The deploy command checks this setting before stopping the service.

Verify after deployment or a recovery:

```bash
pm2 status thanda-store
curl -I https://store.thanda.solar/login
journalctl -u thanda-store-sync.service -n 50 --no-pager
journalctl -u thanda-store-xero-stock.service -n 50 --no-pager
```

Do not commit generated thumbnails, token files, credentials, `node_modules`, or Next.js build output. Product thumbnails are server-generated runtime data under `thanda-store/public/product-images/`.

### Authentication

The sync job authenticates directly against Renogy's portal API using the cached bearer token. On startup it validates the token with `GET /api/sc/portal/user/info`. The five-minute schedule keeps the session active. Renogy's current JWT-shaped token has no exposed `exp` claim, so it must be treated as a renewable session rather than a guaranteed permanent credential. A `401` is a manual intervention signal: complete the normal Renogy username/password/email-OTP login, then securely replace `RENOGY_TOKEN_CACHE_FILE`. The job must not automate or bypass the email OTP flow.

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

### Victron shipment and backorder planning

#### Victron API budget and diagnostics

Every production catalogue/order/tracking request uses `victron-http.mjs`.
PostgreSQL serialises requests per credential fingerprint (no credential is
logged), spaces request starts by at least one second, and stores cooldowns by
catalogue/orders/tracking scope. Numeric and HTTP-date Retry-After values are
honoured; a 429 without a usable header pauses for one hour. Set
`VICTRON_ACCOUNT_WIDE_COOLDOWN=1` in both web and supplier service environments
only if Victron confirms a shared account restriction. Redirects are refused
rather than forwarding credentials to an unexpected host.

Catalogue: six scheduled runs/day, up to 20 requests/run (safety ceiling 120/day,
not a provider quota). Actual pagination is now measured, not inferred from
product counts. Manual catalogue retry is limited to one attempt per 15 minutes,
uses the same advisory lock/cooldown, and times out after 50 seconds. Extended
catalogue maintenance is explicit and capped at 100 requests/run; do not schedule
it routinely. Orders: normally 2 calls/run = 48/day, plus new invoice details and
uncached tracking pages, capped at 80 requests/run including retries. Manual order
attempts require five minutes between starts. A 5xx order request has one retry;
429 never retries in-place. Successful EPX resolutions are reused until their
source URL changes; other successful tracking-page checks are cached for 24h.
Cart uploads and status/page reads make zero provider calls. Account allowance
remains unverified; these are application safeguards, not promised headroom.

Data health shows a rolling 24-hour breakdown by component, trigger and endpoint,
recent 429/transport failures, returned quota headers and persisted retry dates.
New transport failures retain only a fixed, non-sensitive cause category (redirect,
DNS, TLS, connection, timeout, interrupted response or unknown); old entries have
no recorded cause. This changes no request schedule, retry or API budget.
The ledger retains 30 days (pruned at catalogue runs). Interrupted requests remain
`started`, so attempted traffic is not silently lost. Normal cooldown skips do not
overwrite the previous sync result or pretend to be a fresh failure. The stock
freshness window is five hours to accommodate the four-hour catalogue timer.

When deploying these schedules, install the checked-in `thanda-store-victron-sync`
and `thanda-store-victron-orders` service/timer pairs to `/etc/systemd/system/`,
run `systemctl daemon-reload`, restart the catalogue timer, and enable/start the
orders timer. Run `node scripts/init-victron-http.mjs` with the supplier environment
loaded to initialise tables and preserve the legacy cooldown before enabling jobs
or manual retry. Do not manually trigger a
supplier sync simply to verify deployment.

Provisional E-Order cart HTML uploads make zero supplier/Xero calls (including
cold-cache uploads and retries). All parsed SKU quantities are saved in one
transaction. The existing succession-family resolver applies matched quantities;
unmatched lines remain saved and visible, and are reconsidered on each report
reload as the local catalogue changes. Unknown lines never fabricate stock or
silently reduce Suggested. Catalogue enrichment remains the scheduled job's job.

Replenishment's Data health section owns source-wide sync/freshness warnings. Its
New changes badge compares issue states and affected items, not refresh timestamps;
opening the section acknowledges it for this browser tab session. Unresolved
issues remain in the section and resolved issues clear on the next report reload.
Row warnings are reserved for missing item data and overdue inbound balances.
Unknown required quantities still withhold Suggested. This display uses stored
report data only and adds no provider requests.

`npm run sync:victron-orders` makes two normal calls per run: one Shipments
request and one Backorders request. At the hourly production cadence this is 48
requests per day, plus one invoice-products request for each invoice not seen
before. Previously imported invoices are served from PostgreSQL and are not
requested again. Victron has not published an allowance for this account and
successful responses currently expose no quota headers, so the job remains
hourly, uses a 20-second timeout, retries a transient server failure once, and
stops on `429 Retry-After` rather than polling.

The first successful run chooses its cutover from the earliest E-Order shipment
matching an already-open local inbound order; if there is no match it starts at
the current date. `VICTRON_ORDERS_CUTOVER_DATE=YYYY-MM-DD` is an optional
operator override. The chosen date is persisted. Orders after the cutover and
any matching open local orders are imported idempotently by order and invoice
number. Existing received quantities are never reduced or inferred from an API
status. A newly observed billed quantity above the recorded receipt reopens the
remaining balance for physical confirmation.

Backorders replace the previous API snapshot on every successful run. A line
cleared by an administrator stays hidden until Victron stops returning it;
after it disappears, a future reappearance is treated as new. Replenishment
subtracts an open inbound balance for the same order and SKU replacement family
before counting a backorder, preventing the same unit from being counted twice.
Packing-list PDFs and shipment serials are not used to confirm receipt. RMA
references are excluded before any expected quantity is imported.

Images and documents come from the heavier `/api/v1/products-extended/<SKU>/` endpoint. Run this intentionally, not every five minutes:

```bash
cd thanda-store
npm run sync:victron:extended
```

For a manual full supplier recovery, use:

```bash
cd thanda-store
npm run sync:all
```

This runs Renogy and the lightweight Victron sync sequentially. It is not the production schedule. A separate daily timer can run `sync:victron:extended` if product images and documents need routine refreshes.

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

## Customer quote reliability, product details and API

See [Customer commerce](docs/customer-commerce.md) for the local quote ledger and notification worker, contact pricing migration, product resources, API access and deployment checks.

### Mobile navigation

Below 640 px, the storefront header shows the brand, a labelled hamburger button and product search. The expandable navigation contains the same company, account, API, admin, cart and logout controls as desktop, with the same permission checks. Selecting an action, focusing search, clicking outside or pressing Escape closes it; Escape returns focus to the trigger. Opening the menu performs no additional API requests.
