# Customer commerce improvements

## Boundaries and request budget

Xero Hub remains the sole Xero connector. Product details, the customer API, CSV downloads, key management and contact pricing read/write local PostgreSQL only: **zero Xero or supplier calls per request/run/day**, including a cold cache. No new catalogue polling, provider backfills or refresh buttons are introduced. Normal supplier syncs maintain catalogue data and document metadata from their existing responses. SKU successor references come only from `victron_sku_successions`; stock stays on its actual SKU.

Quote creation uses the existing Hub command once, with a durable operation ID and frozen request body. Retries reuse that operation rather than creating a replacement. A successful response is committed locally with notification jobs and the cart update; it requires no extra Xero GET. Uncertain Hub outcomes remain visible for operator reconciliation. Internal Xero drafts are not customer quote requests.

Quote notifications use a PostgreSQL outbox. The worker makes at most 20 Resend calls per one-minute run, at most one per second, with a 15-second request timeout. Each quote creates two email jobs; each job gets at most five send attempts inside a 23-hour safety window using one immutable payload/idempotency key. Up to three later status reads per email check delivery; there is no customer-triggered provider polling. Maximum per quote is 10 send requests and 6 status reads (normally 2 sends and 2 reads); idle daily cost is zero, absolute worker ceiling 28,800 calls/day, further bounded by due jobs and global provider cooldown. No historical notifications are automatically generated.

Resend's [idempotency keys](https://resend.com/changelog/idempotency-keys) expire after 24 hours. [Retrieve email](https://resend.com/docs/api-reference/emails/retrieve-email) supplies `last_event`; acceptance is not delivery. The documented default [rate limit](https://resend.com/docs/api-reference/rate-limit) is 10 requests/second per team; this worker reserves headroom for authentication mail by running at one/second. Returned `Retry-After`, rate-limit and quota observations are retained locally. A 429 pauses the whole worker, not just one job; quota exhaustion/credentials failures stop sending until corrected. Unconfirmed outcomes after the retry window are flagged for sales instead of blindly resent.

## Contact pricing

`contact_supplier_discounts` is keyed by Xero contact ID and supplier. All users on the contact, storefront pricing, carts, quote creation and API exports read this source. Legacy user discounts are retained only as migration evidence. The one-time transaction checks explicit rates and implicit defaults across all contact users and aborts on a conflict; it never silently picks a price. Creating another user does not overwrite existing contact prices. Relinking to another Xero contact selects that contact's pricing, rather than copying the old company's rates.

Admin user editing includes clearly labelled company discount controls; saving applies to every user of the linked contact. API access is separately enabled per user, off by default. Enabled users manage up to three keys in API access. Each bearer secret is shown once and stored only as a hash. Revoking a key or disabling API access takes effect immediately; keys are bound to the original user/contact pair and cannot follow a user to another contact. No credentials are included in documentation or logs.

## API v1

`GET /api/v1/products` accepts `Authorization: Bearer <key>`. Use HTTPS. The same endpoint with `?format=csv` exports the complete catalogue. Signed-in users can download the same pricing data from `/api/account/catalogue.csv` without exposing a bearer secret in a URL.

JSON fields: supplier, SKU, description, price excluding VAT, currency, separate Thanda/supplier stock, immediate successor SKU, source timestamps and company pricing timestamp. Unknown prices/stock timestamps are null. LoRa has no supplier stock. The normal storefront product scope and hidden-product rules apply.

Pagination defaults to 100 rows, maximum 250 (`limit`). Follow the opaque `next_cursor` using `cursor`. It is scoped to the contact and content revision; a changed catalogue returns 409 so the integration restarts the scan. ETags and `If-None-Match` support 304 change detection. Price changes are included in the revision even when catalogue rows have not changed. Rate limiting is 60 requests/minute per user across all their keys; 429 includes `Retry-After`. Berg's integration remains responsible for changes to its own Xero account.

## Product information

Selecting a product image or name opens the details drawer. It reads cached descriptions, structured attributes, supplier technical data and documents. Public HTTPS manufacturer URLs are allowlisted by brand; supplier partner/API links are excluded. A missing description falls back to the product name, and missing links are stated plainly. Existing records gain longer descriptions when the normal supplier sync supplies them; there is no extra detail fetch. `data/product-resources.json` contains reviewed exact-SKU product links with their verification date/source, applied locally by `scripts/seed-product-resources.mjs` (dry run by default; `--write` applies). It merges only `publicResources`, which normal supplier syncs preserve.

## Operations and rollout

1. Read the current server `runtime/CODEX_ALERTS.md`. Take a database backup through the normal operations process. Run `node --env-file=/etc/thanda-store-supplier.env scripts/migrate-customer-commerce.mjs` from the app directory to validate the migration in a rolled-back transaction. Conflicting effective company discounts stop rollout and need a reviewed pricing decision; do not choose the largest discount automatically.
2. Apply the migration with `--write`, then apply reviewed product resources with `node --env-file=/etc/thanda-store-supplier.env scripts/seed-product-resources.mjs --write`. Both are repeatable and local-only. No API users are enabled automatically.
3. Build and restart the app. Install `deploy/thanda-quote-notifications.service` and `.timer` in `/etc/systemd/system`, reload systemd and enable the timer. The worker reads database settings from `/etc/thanda-store-supplier.env` and `RESEND_API_KEY` from a root-only `/etc/thanda-store-notifications.env` (mode 0600), using the existing portal mail credential; never print it. Verify the timer and **User Admin → Quote requests & notifications**.
4. In User Admin, edit the company user, check company discounts and enable API access. The user opens **API access**, names a key and copies the secret once. Disabling API access revokes all their keys. CSV is also available to any signed-in linked customer at `/api/account/catalogue.csv`.

Use `npm run test:customer-commerce` for pure contract tests. With a disposable PostgreSQL database, set `DATABASE_URL` and run `npm run test:customer-commerce:db`; it creates and drops an isolated schema, uses synthetic contacts and mocks all external providers. Tests cover price conflicts, key ownership/revocation/rate limits, Hub success followed by local transaction failure, unchanged replay, concurrent cart changes, and notification cooldown/delivery/retry expiry.

Notification failures are visible to sales in Admin. Temporary errors retry the same immutable payload/key automatically. Permanent failures, uncertain provider outcomes outside the safe retry window, and unconfirmed Hub outcomes require operator review; never recreate a quote or blindly resend an email to clear an error. The worker makes no Xero calls. It does not send historical acknowledgements. Older drafts without recorded portal provenance remain hidden until independently reconciled.

## Validation record (26 September 2026)

- Production pricing migration dry run passed with no conflicting effective company discounts; it was rolled back without changes.
- All six test files passed; the isolated PostgreSQL integration checks passed, including Hub success followed by a failed local cache write and recovery with the same operation key.
- Local HTTP checks passed for company pricing across two users, another company's independent prices, bearer authentication/revocation, pagination, ETag 304 and CSV. Staff drafts stayed hidden while portal requests and exact deep links remained visible.
- The real checkout route against a loopback mock Hub resolved a `PMP482305012` cart line to stocked predecessor `PMP482305010`, submitted once across retries, created two notification jobs and retained the request after a complete but lagging Hub snapshot.
- Chromium checks passed at desktop and 390 px mobile widths: product drawer, Escape/focus return, public document links, key generation/revocation, confirmation link, company pricing/API controls and sales request list. No real quote or email was created by these checks.
- Production build and TypeScript checks passed. ESLint reported zero errors and eight existing warnings.
