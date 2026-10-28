# Customer commerce improvements

## Boundaries and request budget

Xero Hub remains the sole Xero connector. Product details, the customer API, CSV downloads, key management and contact pricing read/write local PostgreSQL only: **zero Xero or supplier calls per request/run/day**, including a cold cache. No new catalogue polling, provider backfills or refresh buttons are introduced. Normal supplier syncs maintain catalogue data and document metadata from their existing responses. SKU successor references come only from `victron_sku_successions`; stock stays on its actual SKU.

Quote creation uses the existing Hub command once, with a durable operation ID and frozen request body. Retries reuse that operation rather than creating a replacement. A successful response is committed locally with both buyer and sales notification jobs and the cart update; it requires no extra Xero GET. There is no application option to suppress either notification. Uncertain Hub outcomes remain visible for operator reconciliation. Internal Xero drafts are not customer quote requests.

Resuming a completed request validates its saved quote identity, customer and validation state, then atomically ensures both notification jobs exist using the same mandatory queue helper as new completion. Missing jobs are restored without calling Hub, changing the cart or republishing quote activity. Existing jobs retain their recipients, message, delivery state, attempts and provider ID, including failed or unconfirmed jobs; resuming never resets or resends them. A manually reconciled quote must also use this helper within its local completion transaction. There is no scheduled historical backfill.

For an explicitly approved live test, generate both normal message payloads and set only those test jobs' recipients to the approved test address before committing either job. Preserve the original request context and message bodies, and record the recipient change in the activity log. Use the normal worker, retries and delivery checks. Do not suppress jobs or change the global sales recipient to test a single request: that setting also affects genuine customer quotes and website enquiries. Automated tests use an isolated database and a fake provider transport while exercising the same queue and worker logic.

Quote notifications use a PostgreSQL outbox. The worker makes at most 20 Resend calls per one-minute run, at most one per second, with a 15-second request timeout. Each quote creates two email jobs; each job gets at most five send attempts inside a 23-hour safety window using one immutable payload/idempotency key. Up to three later status reads per email check delivery; there is no customer-triggered provider polling. Maximum per quote is 10 send requests and 6 status reads (normally 2 sends and 2 reads); idle daily cost is zero, absolute worker ceiling 28,800 calls/day, further bounded by due jobs and global provider cooldown. No historical notifications are automatically generated.

Resend's [idempotency keys](https://resend.com/changelog/idempotency-keys) expire after 24 hours. [Retrieve email](https://resend.com/docs/api-reference/emails/retrieve-email) supplies `last_event`; acceptance is not delivery. The documented default [rate limit](https://resend.com/docs/api-reference/rate-limit) is 10 requests/second per team; this worker reserves headroom for authentication mail by running at one/second. Returned `Retry-After`, rate-limit and quota observations are retained locally. A 429 pauses the whole worker, not just one job; quota exhaustion/credentials failures stop sending until corrected. Unconfirmed outcomes after the retry window are flagged for sales instead of blindly resent.

## Quote availability and lead times

New cart quotes and copied quotes append an availability note after a blank line
in each item's existing description. The note is calculated after replacement
resolution and quantity merging, using the actual article being quoted. Copies
use today's saved evidence; retries of an existing request retain the original
description and stock assessment with the rest of its frozen request body.

Accounting item codes come from the complete saved Thanda Xero Items snapshot
for every supplier. A stock-sync marker alone does not establish whether an
item exists: ordinary Renogy products are outside the local stock importer's
target scope. Codes match the actual quoted article exactly, and Store-managed
products must also match their saved Xero ItemID. No replacement or retail
packaging code is borrowed. This adds one local snapshot read and no Hub,
supplier or Xero request. If that snapshot is unavailable or overdue, the
previous stock-marker behaviour remains; a reliable missing identity is kept
distinct from an unavailable snapshot. Existing frozen requests are not rewritten.

- Enough observed Thanda stock for the full line: **Stock available. Subject to prior sale.**
- Partial Thanda stock: state the quantity available, subject to prior sale, then describe availability for the balance.
- Enough Renogy supplier stock for the balance: **Estimated lead time: 2-4 working days, subject to confirmation.**
- Enough Victron ZA warehouse stock for the balance: **Estimated lead time: 5-7 working days, subject to confirmation.**
- Later Victron supply: use a future planned date from the saved E-Order backorders only where the available dated quantity supports the balance. State the date as an estimate, allow a further 5-7 working days, and explicitly say supplier confirmation is required and timing may change.
- Otherwise: **Stock availability on enquiry.** The balance gets the same qualification when only part of the requested quantity is available locally.

Freshness uses the existing source windows: Thanda 120 minutes, Renogy 20
minutes, Victron ZA 300 minutes and Victron orders 180 minutes. Missing,
invalid, overdue or implausibly future observations cannot establish stock.
Other brands get the local-stock statement only when supported by counted
Thanda inventory; manually maintained marketing wording does not establish a
supplier quantity or lead time. Removed catalogue articles may still have
real Thanda stock, but retained supplier balances do not establish availability.

Later estimates require current successful backorder and accepted-quote
observations. Ignored/RMA backorders and stock already represented as inbound
are excluded. Any accepted reservation in the same confirmed replacement
family withholds a later estimate, and any inbound overlap excludes that
order's family balance. This conservative rule avoids inventing an allocation;
uncertain or committed supply falls back to an enquiry. A date under another
successor article never becomes the quoted article's supply. Retail `R`
packaging aliases remain the same Victron stock article. Shipment dates,
overseas quantities and additional-stock totals never become promised arrivals.
These notes do not reserve stock or change the existing ordering eligibility.

API budget review (26 October 2026): **zero additional supplier, Xero or Hub
requests per quote/run/day**, including a cold cache. Stock, backorders,
reservations and canonical SKU relationships are batched local PostgreSQL
reads; no new provider path, polling, backfill or cache refresh is introduced.
Scheduled imports remain the invalidation source. The existing Hub `/Quotes`
command sends `Quotes[].LineItems[].Description`, as supported by the
[official Xero OpenAPI specification](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml).
Its durable operation ID, response allowance ledger, reserve and cooldown
handling remain in force. Existing limits of 200 new requests per Store and
50 per contact per rolling 24 hours remain unchanged; reaching these limits or
the Hub's reserve/cooldown stops new writes while the existing operation can
still be reconciled. Xero's published limits are 60 calls/minute and five
concurrent calls per organisation, with a daily allowance of 1,000 on Starter
or 5,000 on higher tiers; the Hub's actual returned allowance and configured
reserve remain authoritative. See [Xero's rate limits](https://developer.xero.com/documentation/guides/oauth2/limits/).

Validation from `thanda-store/`:

```bash
node --test --test-isolation=none test/quote-availability.test.mjs \
  test/quote-backorders.test.mjs test/quote-item-identity.test.mjs test/quote-vat.test.mjs \
  test/sku-quote-copy.test.mjs test/catalogue-stock-families.test.mjs
RUN_QUOTE_AVAILABILITY_DB_TESTS=1 node test/quote-availability.integration.mjs
```

The integration command requires `DATABASE_URL` pointing to a disposable local
`quote_availability_test` database. It creates and removes a unique synthetic
schema. Tests create no real quote or email and contact no provider.

## Contact pricing

`contact_supplier_discounts` is keyed by Xero contact ID and supplier. All users on the contact, storefront pricing, carts, quote creation and API exports read this source. Legacy user discounts are retained only as migration evidence. The one-time transaction checks explicit rates and implicit defaults across all contact users and aborts on a conflict; it never silently picks a price. Creating another user does not overwrite existing contact prices. Explicitly moving a person to another company selects the destination contact's pricing; the company identity is never repointed and old rates are not copied.

Company membership and source-freshness regression checks can run against disposable PostgreSQL from `thanda-store/`:

```bash
node --test test/*.test.mjs
RUN_COMPANY_DB_TESTS=1 node test/company-management.integration.mjs
RUN_FRESHNESS_DB_TESTS=1 node test/data-freshness.integration.mjs
RUN_AUTH_DB_TESTS=1 node test/auth-credential-boundary.integration.mjs
```

Set `DATABASE_URL` to a disposable local instance for the integration commands. Each creates and drops a unique synthetic schema. Company tests cover shared-company email edits, validation rollback, explicit movement, credential/cart isolation and pricing. Freshness tests execute the actual stock/sales/reservation jobs against a local fake Hub, covering observed versus imported time, tracked zero versus unknown, failed/partial outcomes and retained evidence. No real supplier, Xero or mail request is made. The existing commerce DB test remains available as `npm run test:customer-commerce:db`.

The credential-boundary suite exercises concurrent identity changes, OTP/session creation, API-key issuance and password setup against the real database. These operations take the same user lock and recheck identity before issuing credentials, so an in-flight request cannot recreate credentials after an email or company edit revoked them. OTP consumption and session creation are one transaction; replacement codes invalidate older unused codes. Setup completion uses the same user-then-token lock order to avoid deadlocks with membership changes.

**Admin → Companies** owns the contact identity, discounts and people list; saving discounts applies to every user of the linked contact. A personal email edit validates against the same company and leaves colleagues unchanged. Explicit company movement revokes only that person’s sessions/codes/keys, disables their API access and clears their cart. API access is separately enabled per user, off by default. Enabled users manage up to three keys in API access. Each bearer secret is shown once and stored only as a hash. Revoking a key or disabling API access takes effect immediately; keys are bound to the original user/contact pair and cannot follow a user to another contact. No credentials are included in documentation or logs.

## API v1

`GET /api/v1/products` accepts `Authorization: Bearer <key>`. Use HTTPS. The same endpoint with `?format=csv` exports the complete catalogue. Signed-in users can download the same pricing data from `/api/account/catalogue.csv` without exposing a bearer secret in a URL.

JSON fields: supplier, SKU, description, price excluding VAT, currency, separate Thanda/supplier stock, immediate successor SKU, source timestamps and company pricing timestamp. Unknown prices, stock quantities and timestamps are null. LoRa has no supplier feed; Hubble's manual availability does not imply a counted supplier quantity. The normal storefront product scope and hidden-product rules apply.

Pagination defaults to 100 rows, maximum 250 (`limit`). Follow the opaque `next_cursor` using `cursor`. It is scoped to the contact and content revision; a changed catalogue returns 409 so the integration restarts the scan. ETags and `If-None-Match` support 304 change detection. Price changes are included in the revision even when catalogue rows have not changed. Rate limiting is 60 requests/minute per user across all their keys; 429 includes `Retry-After`. Berg's integration remains responsible for changes to its own Xero account.

## Product information

Selecting a product image or name opens the details drawer. It reads cached descriptions, structured attributes, supplier technical data and documents. Public HTTPS manufacturer URLs are allowlisted by brand; supplier partner/API links are excluded. A missing description falls back to the product name, and missing links are stated plainly. Existing records gain longer descriptions when the normal supplier sync supplies them; there is no extra detail fetch. `data/product-resources.json` contains reviewed exact-SKU product links with their verification date/source, applied locally by `scripts/seed-product-resources.mjs` (dry run by default; `--write` applies). It merges only `publicResources`, which normal supplier syncs preserve.

## Operations and rollout

1. Read the current server `runtime/CODEX_ALERTS.md`. Take a database backup through the normal operations process. Run `node --env-file=/etc/thanda-store-supplier.env scripts/migrate-customer-commerce.mjs` from the app directory to validate the migration in a rolled-back transaction. Conflicting effective company discounts stop rollout and need a reviewed pricing decision; do not choose the largest discount automatically.
2. Apply the migration with `--write`, then apply reviewed product resources with `node --env-file=/etc/thanda-store-supplier.env scripts/seed-product-resources.mjs --write`. Both are repeatable and local-only. No API users are enabled automatically.
3. Build and restart the app. Install `deploy/thanda-quote-notifications.service` and `.timer` in `/etc/systemd/system`, reload systemd and enable the timer. The worker reads database settings from `/etc/thanda-store-supplier.env` and `RESEND_API_KEY` from a root-only `/etc/thanda-store-notifications.env` (mode 0600), using the existing portal mail credential; never print it. Verify the timer and **User Admin → Quote requests & notifications**.
4. In User Admin, edit the company user, check company discounts and enable API access. The user opens **API access**, names a key and copies the secret once. Disabling API access revokes all their keys. CSV is also available to any signed-in linked customer at `/api/account/catalogue.csv`.

Use `npm run test:customer-commerce` for pure contract tests. With a disposable PostgreSQL database, set `DATABASE_URL` and run `npm run test:customer-commerce:db`; it creates and drops an isolated schema, uses synthetic contacts and mocks all external providers. Tests cover price conflicts, key ownership/revocation/rate limits, Hub success followed by local transaction failure, unchanged replay, concurrent cart changes, notification cooldown/delivery/retry expiry, and atomic repair of missing completed-request jobs without Hub calls or changes to existing delivery records. Invalid saved quote identities cannot initiate notifications.

Notification failures are visible to sales in Admin. Temporary errors retry the same immutable payload/key automatically. Permanent failures, uncertain provider outcomes outside the safe retry window, and unconfirmed Hub outcomes require operator review; never recreate a quote or blindly resend an email to clear an error. The worker makes no Xero calls. It does not send historical acknowledgements. Older drafts without recorded portal provenance remain hidden until independently reconciled.

## Validation record (26 September 2026)

- Production pricing migration dry run passed with no conflicting effective company discounts; it was rolled back without changes.
- All six test files passed; the isolated PostgreSQL integration checks passed, including Hub success followed by a failed local cache write and recovery with the same operation key.
- Local HTTP checks passed for company pricing across two users, another company's independent prices, bearer authentication/revocation, pagination, ETag 304 and CSV. Staff drafts stayed hidden while portal requests and exact deep links remained visible.
- The real checkout route against a loopback mock Hub resolved a `PMP482305012` cart line to stocked predecessor `PMP482305010`, submitted once across retries, created two notification jobs and retained the request after a complete but lagging Hub snapshot.
- Chromium checks passed at desktop and 390 px mobile widths: product drawer, Escape/focus return, public document links, key generation/revocation, confirmation link, company pricing/API controls and sales request list. No real quote or email was created by these checks.
- Production build and TypeScript checks passed. ESLint reported zero errors and eight existing warnings.

## Customer integration documentation

API-enabled, company-linked users can open `/api-access/guide` from **API access → Read API guide**. `/api/account/api-docs` downloads `thanda-api-openapi.json` (OpenAPI 3.1.1); `?format=markdown` downloads `thanda-api-guide.md`. Both downloads check the portal session and current API entitlement on every request, return private/no-store responses, and do not accept API bearer keys in place of a portal session. Disabled or unlinked users cannot retrieve them.

The guide and machine-readable document share `src/lib/commerce/api-documentation.mjs` for field definitions, examples and integration instructions. Keep this contract aligned with `/api/v1/products` when changing the API. Examples are fictional, contain no credentials or live prices, and explain how to configure a key separately from an LLM prompt. Only the customer catalogue operation is documented; administrative and session endpoints are excluded from the OpenAPI operations.

Budget: documentation rendering and downloads perform local session/permission checks only, with **zero Xero, supplier or email calls per request or day**, no backfill and no scheduled job.
