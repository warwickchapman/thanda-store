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
  Prices must be finite numbers or ordinary decimal strings, positive, below
  R10,000,000 and expressible in cents. Booleans, arrays, hexadecimal/exponent
  strings and excess decimal precision are rejected. The same bounds apply to
  calculated list prices and to the Hub's independent validation.
- Existing products: change only `PurchaseDetails.UnitPrice`, preserving the live
  purchase accounting/tax fields and all selling/stock fields.
- New products: reviewed tracked definitions with zero opening-balance writes and
  list selling price. Account mappings: Thanda inventory 631, COGS 311, sales 201;
  Sensible inventory 630, COGS 310, sales 200; INPUT3/OUTPUT3. Hub checks active
  account types and tax mappings before creating. Existing cost updates require
  write permission and preserve the item's current account and tax fields; they
  do not depend on the account defaults used for new products.
- Click **Update** on a cost-change row to apply the displayed purchase cost immediately,
  without a second confirmation. The row shows progress and the outcome.
- Click **Add to Xero** on a new-product row to create the displayed definition.
  Its purchase cost and initial selling price are shown before adding.
- Select up to 50 cost changes or up to 50 new products in one company and confirm
  the batch. Additions and cost updates are separate selections. New-product
  confirmation shows the initial cost, list selling price and zero opening balance.
  There is no automatic Xero writing in scheduled jobs.
- Changed proposals are rejected before any Xero request, with the number of affected
  selections shown. The page clears rejected selections and reloads the saved comparison
  for a new selection; it never automatically retries a write. Mixed-company selections
  have a separate error.
- Applying an update refreshes the comparison from saved evidence. Supplier and Xero
  evidence must be complete and less than 24 hours old. The Hub then checks the
  exact live item IDs and reviewed costs before dispatch. Any mismatch stops the
  whole proposed batch before its write.
- A price selection compares company, literal SKU, item ID and before/after costs.
  Stock movement, description changes and refreshed observation timestamps do not
  invalidate an unchanged cost or repeat its alert. Creation and archive reviews
  retain their relevant descriptive, pricing and stock checks. Freshness is always
  checked separately and is never waived by a matching selection.
- Solar panels are excluded for South Africa by article prefix: `SPM`
  (monocrystalline) and `SPP` (polycrystalline). The broad E-Order category
  **Solar panels and cables** also includes `SCA` cables/connectors and `SLS`
  SolarSense products; those prefixes are not panels and are not excluded by
  this rule. Store catalogue review, Data health creation and the Hub write
  guard use the same prefix rule. 120V-only and solar-home-system products still
  require review. The original supplier observation is retained.
- Pricing applies to literal article codes, never across a successor family.
  `victron_sku_successions` provides predecessor/successor labels; the shared
  resolver recognises R packaging aliases and prevents automatic duplicate creation.

## Daily alert and retirement checklist

The daily timer runs at 07:00 Africa/Johannesburg. It adds an in-app Admin menu
alert for new changes, a failed comparison or an overdue run. Acknowledgement
persists for the exact change set; refreshing observation timestamps alone does
not repeat an alert. No email delivery or recipient configuration is included.

**Needs review** counts only held products with positive stock in Victron's ZA
warehouse. These review candidates appear first, sorted by SKU. Products with
zero or unknown ZA stock remain listed below as **Silenced**, with the reason
for their hold; they do not contribute to the dropdown count or change alerts.
Unknown remains labelled **Unknown**, never zero. This only prioritises the
review queue; an administrator resolves candidates using the row actions.

- **Add to Xero** accepts the displayed eligibility advice and creates a missing
  item at its displayed purchase cost and initial list selling price.
- **Update** accepts the advice and changes an existing item's purchase cost to
  the displayed proposal. **Keep in Xero** accepts advice for an existing item
  whose saved cost already matches; it makes no Xero request. The page identifies
  existing items so they are never presented as missing products.
- **Ignore for 90 days** removes the review candidate from the count and change
  alerts for that company and literal SKU. It stays visible with its expiry date.
  **Undo ignore** brings it back immediately. The next daily/manual comparison
  after expiry returns a ZA-stocked item to the active review queue. Stock arriving
  during the ignore period does not end it early.
- Acceptance applies only to the displayed complete set of regional/voltage
  advice. An additional advisory reopens review. Pricing errors, solar-panel
  prefixes, duplicate packaging, phase-out creation and disabled or unknown
  purchasing status remain independent blockers. Hard-blocked rows show their
  reason and still offer ignore; they cannot be added or updated through review.
- Decisions are audited in `victron_catalogue_events` with actor, company and SKU.
  Acceptance is saved only after a confirmed Xero result, or locally for **Keep
  in Xero**. Unknown/rejected writes never accept eligibility. The latest approval
  and ignore/undo events supply durable state without a second decision table.
  Ignore expiry uses the database's event time plus 90 days. An ignore applies
  only to review rows; it cannot suppress later normal price or archive changes.

ZA stock comes exclusively from each literal article's
`all_stock_by_warehouse.af_sa_inzuzo`. Xero/company stock, other warehouses,
generic supplier stock, successors and retail siblings do not contribute.
The next daily comparison, or **Compare saved records**, promotes a silenced
item automatically when the saved ZA quantity becomes positive. Supplier data
continues to refresh on its existing four-hour schedule. Changes between positive
quantities do not repeat an alert or invalidate an approval; a candidate returning
after a silenced comparison alerts again even if its earlier alert was acknowledged.
Failed or overdue comparisons continue to alert independently of this queue.

After deploying this change, run one saved comparison to populate ZA quantities
and review actions, and replace old category-based exclusions in saved rows.

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
   Both Xero organisations must separately consent to explicit item management
   (`accounting.settings`). Reconnect using Sensible Cloud's existing Thanda and
   Sensible connection links; the Hub requests this scope alongside existing
   permissions and only records it as granted after a successful Xero callback.
   Missing consent blocks item commands locally, before any Xero request.
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
OAuth scopes reference on 2026-10-06. Xero's guide lists Items under both invoices
and settings, but the production grant with invoice access and read-only settings
received HTTP 401 on item writes. The catalogue now requires explicit
`accounting.settings` consent; it does not infer item-write readiness from invoice
access. Existing Hub caller capabilities remain unchanged, and reconnecting never
marks requested permissions as granted before Xero actually returns them.

| Path | Upstream calls per run | Scheduled daily cost |
| --- | --- | --- |
| Store render, menu alert, audit | 0 | 0 |
| ZA review ordering, counting and silencing | 0; uses saved catalogue during existing comparisons | 0 additional |
| Ignore / undo / Keep in Xero | Saved Hub pages only; **0 Xero**, **0 supplier** | 0 additional |
| Review candidate Add / Update | Existing single-item audited create/update command: 1 filtered Items check + 1 write | Only on the row action |
| Full catalogue evidence save | 0 additional; uses existing validated catalogue fetch | 0 additional |
| Compare saved Items | Up to 50 local Hub pages per company, 1,000 items/page; **0 Xero** | 0 Xero |
| Confirm 1–50 cost updates | 1 `GET /Items` + 1 `POST /Items` batch | Only on approval |
| Click Update for one cost change | 1 filtered `GET /Items?where=Code=="…"` + 1 `POST /Items/{ItemID}` | Only on approval |
| Create one item | 1 filtered `GET /Items` + 1 create-only `PUT /Items` | Only on approval |
| Confirm 1–50 new products | 1 `GET /Items` + 1 create-only `PUT /Items` batch | Only on approval |
| Archive / quarterly record | 0 | 0 |
| Operator reconciliation of one uncertain item | 1 filtered `GET /Items`; no write | Only on explicit investigation |

The official GET Items operation returns the collection without a pagination
parameter; the batch preflight uses one GET and indexes the reviewed codes locally.
No per-item requests occur within a cost or creation batch. For 1,000 additions
or changed costs this is 20 batches / 40 Xero calls per company. There is no
automatic backfill or retry loop. One existing SKU stops the whole creation batch
before writing; create-only PUT cannot update an existing item. Replacement labels
and retail-packaging exclusions still come from the shared saved comparison. A
creation batch cannot contain both standard and R retail packaging for one stock
item; select one packaging version. Successor article codes remain distinct.

Batch creation was checked against the official [Xero OpenAPI specification](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml)
on 2026-10-06: `PUT /Items` (`createItems`) accepts an Items array and an
idempotency key. The existing `GET /Items` operation supports the single-item
`where` filter; its complete collection is used once for a batch. Normal page
loads and comparison refreshes continue to use saved Hub data only. Successful
commands update the saved Items and refresh the comparison; uncertain outcomes
retain the saved attempt for reconciliation, without resending any member.

Xero's [published limits](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits/)
are 60 calls/minute and five concurrent calls per tenant, with 1,000 daily calls
on Starter or 5,000 on higher tiers. Actual returned allowances and retry deadlines
remain authoritative; this feature retains the lower shared item-command ceiling
and reserve described below for other sync and interactive work.

All item command paths share a maximum of 100 attributed Xero requests per tenant
per UTC day, at least 15 seconds between actions, and the connector's protected
150-call reserve. OAuth traffic is separately recorded by the existing connector.
Provider quota and Retry-After headers remain authoritative and are retained in the
Hub ledger. Timeouts are bounded; there are no automatic write retries. Failed
reads preserve the previous review and add an error, never an empty success.

Commands are persisted before dispatch and serialised with other item creation.
The Store saves the exact submitted proposals in an attempt audit before contacting
the Hub. Every accepted submission gets new random command identifiers, separate
from the stable comparison fingerprints, so a later genuine price cycle is a new
operation. Replays of a Hub command return its recorded successful result; there
are no automatic Store retries. A timeout, malformed response, or
partial batch outcome blocks every member SKU, even under a new review ID. An
operator must reconcile the saved request against Xero before retrying; do not
blindly mark an uncertain command retryable. The Hub updates its stored item
projection only after every expected result is confirmed. A subsequent scheduled
Items sync reconciles any partial outcome. Existing jobs share the same reserve.

Non-JSON responses and lost connections are recorded as uncertain, with a clear
reconciliation message instead of raw server/parser errors. A successful write
remains reported as successful even if the subsequent audit finalisation or saved
comparison refresh fails; the operator sees a separate warning. Optional quota
headers must never break response processing: missing/malformed day allowance is
unknown, and an invalid Retry-After falls back to 60 seconds for a 429 response.

Reconciliation preserves history. Check the exact tenant, item ID, SKU and current
purchase cost against the saved command. Record the verified evidence and outcome
before closing an uncertain command as `reconciled`; this is not a successful-write
claim and does not replay it. Any later update requires a fresh operator action.
A scheduled Items sync alone does not close an uncertain command.

On 6 October 2026, the uncertain Thanda attempt for `ASS030720118` was reconciled
with one filtered Hub GET at 09:39:34 UTC. The verified cost remained R165.38;
R144.90 was not retried. The original command and fresh evidence were retained,
and a `reconciled` event was added to the Store audit.

## Verification

- `node --test test/victron-catalogue-review.test.mjs test/victron-catalogue-route.test.mjs test/victron-pricing.test.mjs test/victron-sku-family.test.mjs test/xero-item-create.test.mjs`
  includes the actual Store route boundary with plain-text errors, lost connections,
  audit failures, deferrals, stable selections and separate operation identifiers,
  plus 50-product creation batches for both companies, packaging conflicts,
  mixed/stale selections and incomplete creation confirmations.
- `DATABASE_URL=…/victron_review_test node test/victron-catalogue.integration.mjs`
  requires an isolated disposable PostgreSQL database; it resets only its test tables.
- `npx tsc --noEmit --incremental false` and focused ESLint.
- Companion Hub: `pytest tests/test_victron_creation.py tests/test_victron_commands.py tests/test_victron_connector.py tests/test_hub.py`
  with its isolated `xero_hub_test` database. Connector regressions use the real
  authenticated route, connector and database, mocking only upstream HTTP.
