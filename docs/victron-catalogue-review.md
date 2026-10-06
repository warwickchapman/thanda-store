# Daily Victron catalogue review

Admin → **Victron catalogue review** compares the complete saved E-Order catalogue
with complete, tenant-isolated Xero Item snapshots. It is independent of the
quarterly Store assortment allowlist: new inventory candidates are discovered
without automatically publishing them to the storefront.

## Pricing and approval

- Thanda purchase cost: normal E-Order `price`, explicitly in ZAR, excluding VAT.
- List price: use E-Order `enduser_price_zar.price` when present. If missing,
  calculate it as normal E-Order Thanda cost ÷ **0.525**, rounded to cents.
  Calculated list prices are labelled in the review and creation preview.
- Sensible purchase cost: list price × **0.60**, rounded to cents.
- The same explicit-or-calculated list price initialises new-item selling prices.
- Do not use quantity-break prices. Missing/zero/non-ZAR account costs and invalid
  supplied list prices still require review; the fallback applies to missing list prices.
- Existing products: change only `PurchaseDetails.UnitPrice`, preserving the live
  purchase accounting/tax fields and all selling/stock fields.
- New products: reviewed tracked definitions with zero opening-balance writes and
  list selling price. Account mappings: Thanda inventory 631, COGS 311, sales 201;
  Sensible inventory 630, COGS 310, sales 200; INPUT3/OUTPUT3. Hub checks active
  account types and tax mappings before writing.
- Select up to 50 cost changes in one company and confirm the batch. New products
  are individually confirmed. There is no automatic Xero writing in scheduled jobs.
- Confirmation refreshes the comparison from saved evidence. Supplier and Xero
  evidence must be complete and less than 24 hours old. The Hub then checks the
  exact live item IDs and reviewed costs before dispatch. Any mismatch stops the
  whole proposed batch before its write.
- `SPM`/`SPP` and classified solar panels are excluded for South Africa; 120V-only
  and solar-home-system products require review. These exclusions do not exclude
  solar chargers. The original supplier observation is retained.
- Pricing applies to literal article codes, never across a successor family.
  `victron_sku_successions` provides predecessor/successor labels; the shared
  resolver recognises R packaging aliases and prevents automatic duplicate creation.

## Daily alert and retirement checklist

The daily timer runs at 07:00 Africa/Johannesburg. It adds an in-app Admin menu
alert for new changes, a failed comparison or an overdue run. Acknowledgement
persists for the exact change set; refreshing observation timestamps alone does
not repeat an alert. No email delivery or recipient configuration is included.

A missing product becomes an archive candidate after two distinct complete daily
supplier observations. A failed/empty/incomplete fetch cannot establish absence.
Stock zero alone does not establish discontinuation. An explicit replacement or
“Available until stock 0” marker plus confirmed supplier zero stock also qualifies
for the manual archive checklist. Xero archival is a **manual
checklist**, not API deletion or disabling purchase/sale fields. The operator must
check outstanding orders and complete archival in Xero. Recording completion
requires known zero stock and is audited. The record hides that absence episode
from the checklist; renewed availability resets the episode.

The official announcement and PDFs are quarterly sanity-check evidence, never a
replacement price authority. Record the quarter, document reference, checks and
discrepancies in the page. Q4 2026 announcement (1 October) highlights immediate
Venus GX end of life, gradual Lithium Smart phase-out, article-number changes and
November EV charger launches. These are review prompts, not automatic SKU mappings
or instructions to archive. PDF price extraction/comparison remains a manual check.

## Enablement (not performed by local implementation)

1. Deploy the companion Hub `victron_commands` router and the Store changes.
2. Provision a dedicated Hub caller for `thanda-solar,sensible-solar` with only
   `read,victron:write`; set its secret as `XERO_CATALOGUE_HUB_TOKEN` in the Store
   server environment and `/etc/thanda-store-xero.env`. Do not broaden the ordinary
   Thanda caller or expose this token to the browser. `XERO_HUB_URL` is also required.
3. The next complete supplier sync saves the full catalogue evidence. It adds no
   supplier calls. Tables initialise idempotently on sync/review.
4. Run `npm run review:victron` with both supplier database and Xero Hub environments.
   Confirm the saved comparison, charts of accounts and price source against a
   small October sample before applying a reviewed batch.
5. Install the checked-in `thanda-store-victron-review.service` and `.timer` using
   the project's authorised deployment procedure. The service reads supplier and
   Xero environment files. Enable/start the timer only after the first comparison.
6. Archive checklist completion remains in Xero. Daily alerts appear in the Admin
   menu; use the audit history to review approvals and quarterly checks.

## API budget and failure behaviour

Official contract checked against Xero OpenAPI `xero_accounting.yaml` and the
OAuth scopes reference on 2026-10-05. Reuse the Hub's existing item-write scope
validation; no OAuth grant or capability is changed by this implementation.

| Path | Upstream calls per run | Scheduled daily cost |
| --- | --- | --- |
| Store render, menu alert, audit | 0 | 0 |
| Full catalogue evidence save | 0 additional; uses existing validated catalogue fetch | 0 additional |
| Compare saved Items | Up to 50 local Hub pages per company, 1,000 items/page; **0 Xero** | 0 Xero |
| Confirm 1–50 cost updates | 1 `GET /Items` + 1 `POST /Items` batch | Only on approval |
| Confirm one cost update | 1 filtered `GET /Items?where=Code=="…"` + 1 `POST /Items/{ItemID}` | Only on approval |
| Create one item | 1 filtered `GET /Items` + 1 create-only `PUT /Items` | Only on approval |
| Archive / quarterly record | 0 | 0 |

The official GET Items operation returns the collection without a pagination
parameter; the batch preflight uses one GET and indexes the reviewed codes locally.
No per-item requests occur within a cost batch. For 1,000 changed costs this is
20 batches / 40 Xero calls per company, plus any individual new-item actions.

All item command paths share a maximum of 100 attributed Xero requests per tenant
per UTC day, at least 15 seconds between actions, and the connector's protected
150-call reserve. OAuth traffic is separately recorded by the existing connector.
Provider quota and Retry-After headers remain authoritative and are retained in the
Hub ledger. Timeouts are bounded; there are no automatic write retries. Failed
reads preserve the previous review and add an error, never an empty success.

Commands are persisted before dispatch and serialised with other item creation.
Replays return the recorded successful result. A timeout, malformed response, or
partial batch outcome blocks every member SKU, even under a new review ID. An
operator must reconcile the saved request against Xero before retrying; do not
blindly mark an uncertain command retryable. The Hub updates its stored item
projection only after every expected result is confirmed. A subsequent scheduled
Items sync reconciles any partial outcome. Existing jobs share the same reserve.

## Verification

- `node --test test/victron-catalogue-review.test.mjs test/victron-sku-family.test.mjs test/xero-item-create.test.mjs`
- `DATABASE_URL=…/victron_review_test node test/victron-catalogue.integration.mjs`
  requires an isolated disposable PostgreSQL database; it resets only its test tables.
- `npx tsc --noEmit --incremental false` and focused ESLint.
- Companion Hub: `pytest tests/test_victron_commands.py tests/test_hub.py` with its
  isolated `xero_hub_test` database; upstream Xero calls are mocked.
