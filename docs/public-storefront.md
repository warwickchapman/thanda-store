# Public product selection and website enquiries

The marketing website can show a small reviewed selection from Thanda Store and hand visitors to `https://store.thanda.solar/request-quote`. Visitors can request products or describe a solution without creating an account. Sales reviews every enquiry before preparing a quotation. Nothing in this flow creates a Xero contact, quote, invoice, order or marketing subscription.

## Product ownership and response contract

`thanda-store/data/public-featured-products.json` is the checked-in merchandising selection. Each entry has `supplier`, exact `sku`, short `summary` and `position`. The first selection contains seven Victron products and the Thanda LoRa Relay Switcher, observed in the saved live catalogue on 24 October 2026. They are **Featured products**, not a claimed best-seller ranking.

`GET /api/public/featured-products` reads the existing PostgreSQL catalogue and canonical SKU succession tables. It returns `{ selection: 'curated', products: [...] }`. Each product contains only `id`, `supplier`, `sku`, `name`, `category`, `summary`, `imageUrl`, `requestQuoteUrl` and `availability: { local, observedAt }`. The ID is resolved from the exact selected SKU or its explicit canonical replacement family. No supplier cost, commercial metadata, company discount, public retail price, exact inventory quantity or sales/customer history is returned. The cost-bearing authenticated catalogue serializer is deliberately not used.

Selection requires a reviewed config entry and a currently visible unrestricted product. Hidden items, Enertec previews and any row-level catalogue restriction fail closed. A canonical successor can replace a configured older SKU; an unrecorded name similarity cannot. Victron retail `R` packaging aliases use the existing normalizer. A representative's stock remains its own: only a fresh, tracked Thanda stock observation within two hours can show `in_stock` or `out_of_stock`. Missing, stale or implausibly future observations remain `unknown`. Supplier stock does not become a local shipping promise.

Images use existing generated public thumbnails, or safe public Victron manufacturer URLs without credentials or query strings. Missing images remain null. New requests do not generate thumbnails or contact a supplier. The existing product/media protection remains in force.

The successful feed response has a 60-second cache. CORS permits only `https://dev.thanda.solar`, `https://thanda.solar`, `https://www.thanda.solar` and local QA `http://127.0.0.1:18774`, without credentials. `Vary: Origin` protects shared caches. A feed failure returns a generic 503/no-store response; the marketing site should retain a working generic enquiry link.

## Visitor flow

`/request-quote` is the sole new anonymous Store page. The existing Store root, account, admin and trade flows retain their login rules. Repeated `product` query parameters preselect products, for example `/request-quote?product=123&product=456`; a single item can also use `quantity=2`.

The form accepts a name, email, town/postcode, optional phone/company, delivery or collection preference, optional message and up to eight selected products. Quantities are whole numbers from 1 to 100. A visitor can submit a general solution or LoRa enquiry without selecting products; a message is then required. The response gives a durable opaque reference and explains that stock is not reserved and no order has been placed.

`POST /api/public/quote-requests` accepts JSON from the same Store origin only. It caps actual body bytes at 16 KiB, validates bounded fields, rejects the honeypot and implausible form timing, and resolves each selected product against the current public selection. Client-supplied names, prices, recipients and product metadata are ignored. The request ID is UUIDv4. An atomic PostgreSQL transaction saves the enquiry and one staff notification. Retrying the same normalized client details and product IDs/quantities under that ID returns the same minimal receipt; changed client details conflict. Saved operations are recognised before consulting the current catalogue, so a lost response remains recoverable after a product title edit, hiding or a recorded replacement. The original product snapshot and notification remain unchanged. There is no public lead lookup or customer data response.

Durable limits allow ten new enquiries per client bucket per hour, five per normalized email in 24 hours and 100 globally in 24 hours. Replays do not consume another slot. Rate buckets older than two days are removed during subsequent successful submissions. All proxy headers are ignored by default, so unattributed traffic shares a conservative client bucket. Set `PUBLIC_RFQ_TRUST_PROXY=1` **only after confirming that the serving reverse proxy overwrites `X-Real-IP` and the application is not directly internet accessible**. Arbitrary `X-Forwarded-For` values are never used.

`guest_quote_requests` and `guest_quote_notifications` are separate from Xero-backed authenticated quote records. Tables are created once per application process, under a database advisory lock; the explicit migration below prepares them before launch. A save remains successful when mail is delayed. Customer acknowledgements are shown in the browser; this anonymous endpoint does not send mail to arbitrary submitted addresses.

## Sales workflow

Administrators open **Admin menu → Website enquiries** (`/admin/guest-quote-requests`). The newest 100 records appear, with active enquiries first. Staff can review contact details, product selection, delivery preference, message and mail state, record notes, and move the enquiry through New, In review, Quoted and Closed. API access requires a real administrator session; an impersonated account cannot read or manage the ledger. Updates require same-origin JSON. Staff notes and contact details are never exposed by public routes.

Sales confirms product suitability, price, VAT, availability and fulfilment before preparing any formal quote through its established process. Public retail prices are deliberately omitted until the selling-price policy is approved. Handle retention/deletion of these local sales records under Thanda's contact-data policy; the form does not imply marketing consent.

## Notification budget and provider behaviour

There are **zero Xero, Hub or supplier calls** from the public feed, request page, enquiry submission, admin list or updates, including a cold catalogue read. No backfill, polling timer or external catalogue refresh is added.

The existing one-minute `thanda-quote-notifications` worker serves both outboxes under one provider cooldown and advisory lock. Each run has a shared 45-second deadline and at most 20 Resend calls: up to 16 existing quote calls and four guest calls. The queues alternate early in the run so a slow quote backlog cannot starve website enquiries; empty queues are skipped. Calls are separated by one second and time out after 15 seconds. Guest idle cost is zero; its absolute ceiling is 5,760 calls/day before due-job and submission limits. Each enquiry queues one staff mail, normally one send plus one delivery read; retries are bounded at five sends within 23 hours and three status reads. The immutable `guest-rfq-<reference>-sales` key prevents duplicate sends within the provider's 24-hour idempotency period. Existing quote keys remain unchanged.

Resend documents a default team limit of [10 requests/second](https://resend.com/docs/api-reference/rate-limit) and [24-hour idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), checked on 24 October 2026. Returned allowance and quota headers are retained in `portal_notification_state`; `429`, quota and credential failures pause both queues. Provider-specific paid/free quotas remain unchanged. A failed or expired notification stays visible to sales; it is never blindly resent after the safe retry window. Authentication email keeps the existing headroom; no new credential is required.

## Rollout and checks

Use the existing guarded deployment process after review; do not deploy from the unrelated dirty development checkout. Before enabling the page, prepare the local tables from the committed production application directory:

```bash
node --env-file=/etc/thanda-store-supplier.env scripts/migrate-public-rfq.mjs --write
```

Without `--write`, the command prints the intended migration and makes no database or provider request. The existing quote notification timer reads the updated worker after deployment; no new timer or mail credential is needed. Verify its status and shared cooldown, exact anonymous feed fields, selected product handoff, generic enquiry page and admin denial for guests. A public HTTP GET or malformed request cannot create a lead or send mail. Use a disposable synthetic database and injected mail provider for submission tests.

Focused checks from `thanda-store/`:

```bash
node --test test/public-storefront.test.mjs test/public-rfq-routes.test.mjs test/public-notification-scheduling.test.mjs test/customer-commerce.test.mjs test/catalogue-access.test.mjs test/sku-successions.test.mjs
RUN_PUBLIC_RFQ_DB_TESTS=1 DATABASE_URL=<disposable-test-database> node test/public-rfq.integration.mjs
npm run build
```

The database suite creates and drops only a randomly named synthetic schema. It must never be pointed at a customer application schema. It sends no real email and makes no Xero, Hub or supplier request. Inspect the guest page at desktop and mobile widths, exercise selection/removal/quantity and required-field states, and verify the durable reference using the synthetic test app before launch.

## Validation record · 24 October 2026

- The production Next.js/Turbopack build and TypeScript check passed. The full local unit/route test collection passed, including the existing catalogue, account, pricing and quote checks.
- New focused checks cover eight public selection cases, 17 actual handler/input cases, seven notification scheduling cases and 11 disposable PostgreSQL scenarios. The latter include concurrent retries, immutable replay after catalogue changes, trigger-induced rollback, durable rate limits, provider cooldown and idempotent mail recovery. All provider requests were mocked.
- Chromium exercised the built app at 1,440 px desktop and 390 px mobile widths: product selection/removal, quantity changes, contact fields, a synthetic saved enquiry, no horizontal overflow and no browser errors. Retrying the original browser request after hiding/renaming its selected product returned the original receipt and retained exactly one enquiry/outbox row; a new request for the hidden item was rejected. General enquiries require a message. Anonymous admin/catalogue access and Store-root login protection remained intact.
- Both test database schemas were removed and the local browser server stopped. No real email, supplier request, Xero/Hub write, commit push or deployment was performed by these checks. Product imagery in the browser fixture was intentionally empty; live cached image presence was checked separately when choosing the selection.
