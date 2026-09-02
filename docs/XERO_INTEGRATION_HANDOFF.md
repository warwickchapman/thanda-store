# Xero Integration Handoff

This document describes the Xero integration that exists in Thanda Store, the operating rules behind it, and the boundaries a developer must preserve. It is an implementation handoff, not a replacement for Xero's official API contract.

Read this alongside the root [README](../README.md), which remains the operational source of truth for deployment and the complete supplier/store architecture.

## 1. Purpose and boundaries

Xero is used for four distinct concerns:

1. KZN stock: Xero Items are the source of truth for Thanda-held stock.
2. Customer identity: a buyer organisation must link to one active Xero Contact before buyer login is allowed.
3. Sales history: issued customer invoices rank Home `My favourites` and `Popular` products.
4. Draft quotes: the cart creates a draft Xero Quote against the logged-in buyer's linked Contact.

The portal is not a live Xero client. Storefront page rendering must query PostgreSQL only. Xero calls happen through bounded background jobs or deliberate administrative actions. This is both a performance requirement and an API-allowance requirement.

### Explicitly not implemented

- Quote acceptance, invoice creation, payment, credit-note, fulfilment, and return workflows are not automated by the portal.
- There is no Xero Item webhook. Item stock is reconciled by bounded polling.
- There is no Xero Quote webhook. Accepted-quote reservations use a bounded periodic snapshot.
- Xero remains the source for linked contact name and eligible people, but the portal maintains authentication data, roles, discount configuration, sessions, OTPs, carts, and audit state locally.

Do not present a draft quote as an order. The buyer-facing action is intentionally named `Quote me!`.

## 2. Official documentation and contract sources

Before changing any Xero call, check the official OpenAPI contract first. Do not infer unsupported parameters, filtering, or batching behaviour from examples.

| Subject | Official source |
| --- | --- |
| OpenAPI 3 source of truth | [XeroAPI/Xero-OpenAPI](https://github.com/XeroAPI/Xero-OpenAPI) |
| Developer getting started guide and API Call Efficiencies | [Xero developer documentation](https://developer.xero.com/documentation/getting-started-guide/) |
| API call efficiency: reducing polling | [Reducing polling](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/reducing-polling/) |
| Accounting API overview | [Accounting API](https://developer.xero.com/documentation/api/accounting/overview) |
| OAuth 2.0 scopes | [OAuth scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/) |
| Webhooks overview | [Xero webhooks](https://developer.xero.com/documentation/guides/webhooks/overview/) |
| Paging guidance | [Paging](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/paging) |
| Xero app management | [Developer app management](https://developer.xero.com/app/manage) |
| Plan and allowance terms | [Xero pricing](https://developer.xero.com/pricing) |

The current starter-plan design assumes a tenant allowance of 1,000 requests per day and 60 requests per minute. Headers from actual responses are authoritative and are persisted locally. Reconfirm plan limits in the Xero Developer portal before changing schedules.

## 3. OAuth connection

### App type and redirect URI

Use a Xero Web App. The configured production redirect URI is:

```text
https://oc.sensible.co.za/api/xero/callback
```

### Required environment variables

These are stored in the root-owned `/etc/thanda-store-xero.env` on the VPS. They must never be committed, printed, copied to shell history, or exposed through the admin UI.

```text
DATABASE_URL=...
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=https://oc.sensible.co.za/api/xero/callback
XERO_TOKEN_FILE=/var/lib/thanda-store/xero-token.json
XERO_CONNECT_SECRET=...
XERO_WEBHOOK_KEY=...
```

`XERO_TOKEN_FILE` contains the selected tenant ID, access token, rotating refresh token, granted scope list, and expiry metadata. It is created with mode `0600`.

### Current scopes

The code requests exactly:

```text
offline_access
accounting.settings.read
accounting.contacts.read
accounting.invoices
```

Their current use is:

| Scope | Purpose |
| --- | --- |
| `offline_access` | Rotating refresh token for background jobs. |
| `accounting.settings.read` | Xero Items and KZN stock sync. |
| `accounting.contacts.read` | Contact matching and primary/additional-person access reconciliation. |
| `accounting.invoices` | Sales-history reads and draft Quote creation in the present implementation. |

If a changed capability needs more access, add only the necessary documented scope, deploy, and reconnect. Scope changes do not affect the old consent until an administrator reconnects Xero.

### Connection flow

1. An operator opens `/api/xero/connect?secret=<XERO_CONNECT_SECRET>` or uses the admin reconnect control.
2. `/api/xero/connect` creates a cryptographically random state, stores it in a secure, HTTP-only cookie, and redirects to Xero.
3. `/api/xero/callback` checks state, exchanges the code, fetches available connections, selects `XERO_TENANT_ID` when configured or the first connection otherwise, and writes the token file.
4. Calls refresh the access token with the rotating refresh token when it is within 60 seconds of expiry.

The OAuth implementation is in [oauth.ts](../thanda-store/src/lib/xero/oauth.ts). The unauthenticated reconnect endpoint is protected by `XERO_CONNECT_SECRET`; the admin reconnect route avoids sending that secret to the browser.

## 4. Core code map

| Area | Source | Responsibility |
| --- | --- | --- |
| OAuth and common Accounting fetch | [oauth.ts](../thanda-store/src/lib/xero/oauth.ts) | OAuth URLs, token refresh/persistence, tenant headers, exact contact lookup. |
| OAuth start/callback | [connect route](../thanda-store/src/app/api/xero/connect/route.ts), [callback route](../thanda-store/src/app/api/xero/callback/route.ts) | Secure consent lifecycle. |
| Web receiver | [webhooks route](../thanda-store/src/app/api/xero/webhooks/route.ts) | HMAC verification, dedupe, fast durable queue insert. |
| Webhook worker | [process-xero-webhook-events.mjs](../thanda-store/scripts/process-xero-webhook-events.mjs) | Changed Invoice and Contact record processing. |
| Local stock sync | [sync-xero-stock.mjs](../thanda-store/scripts/sync-xero-stock.mjs) | Xero Item read and KZN stock write-back. |
| Favourites safety-net sync | [sync-xero-sales-history.mjs](../thanda-store/scripts/sync-xero-sales-history.mjs) | Incremental 12-month invoice-line cache. |
| Contact safety-net sync | [sync-xero-contact-access.mjs](../thanda-store/scripts/sync-xero-contact-access.mjs) | Removes portal access for people removed from Xero. |
| Quote endpoint | [quotes route](../thanda-store/src/app/api/quotes/route.ts) | Reprices cart and creates draft quote. |
| Accepted-quote snapshot | [sync-xero-accepted-quotes.mjs](../thanda-store/scripts/sync-xero-accepted-quotes.mjs) | Replenishment reservation snapshot. |
| Admin status | [status route](../thanda-store/src/app/api/admin/xero/status/route.ts) | Cached connection/scope/allowance display. |
| Unit templates | [deploy/systemd](../deploy/systemd) | Production timers and workers. |

## 5. Data ownership and mappings

### Products and stock

- `products.details.localStockOnHand` is the KZN quantity from Xero `Items[].QuantityOnHand`.
- The store only syncs all Victron products and the LoRa placeholder SKU `LORA-RS-00120` from Xero Items.
- An absent Xero Item or `IsTrackedAsInventory !== true` is treated as local stock zero.
- Renogy supplier stock is not taken from Xero.
- For LoRa only, the Xero sales price is also stored as the portal list/buyer price. Victron and Renogy buyer prices never derive from Xero cost.

### Organisations and buyers

- `organisations.xero_contact_id` is the durable link to a Xero Contact.
- The company name is read from Xero Contact `Name` and cached locally for display; the portal must not become a second company-name source of truth.
- The Xero Contact primary email is the first eligible login. `ContactPersons` may be explicitly enabled as additional users for that same organisation.
- `sales@thanda.solar` is excluded from Xero Additional people listings.
- If a linked Contact is archived or an enabled primary/additional person disappears from Xero, the portal archives that user and revokes sessions and outstanding OTP/setup tokens.
- Re-adding a person in Xero does not automatically restore access. An administrator must explicitly enable them.

### Sales history and favourites

The derived table `xero_sales_invoice_lines` stores SKU/quantity rows only for:

- `Type = ACCREC`;
- `Status = AUTHORISED` or `PAID`;
- a valid Xero Contact ID and invoice date; and
- the most recent 365 days.

Drafts, voids, quotes, credit notes, and lines without an ItemCode/SKU do not rank products. Catalogue SKU succession is resolved locally; discontinued SKUs no longer in the current catalogue fall out of Home results.

### Quotes

`POST /api/quotes` performs these steps atomically from the buyer's perspective:

1. Requires an authenticated user linked to a Xero Contact.
2. Reads local cart SKUs and quantities.
3. Re-resolves Victron successor-family fulfilment using current local and supplier stock.
4. Reloads the current catalogue and user discounts; no cart-saved price is trusted.
5. Posts one `DRAFT` Quote with `LineAmountTypes: Exclusive`.
6. Sets `UnitAmount` to current list price excluding VAT and `DiscountRate` to the buyer's current discount. LoRa is zero discount.
7. Sends `ItemCode` only where the product exists in Xero stock data; preserving a valid Xero quote even for portal-only catalogue items.
8. Clears the cart only after Xero returns success.

It creates a draft only. Do not change this to auto-accept, invoice, email, or fulfil a quote without a separately approved business workflow.

## 6. Webhooks: the normal update path

The Xero Developer app must subscribe to:

- Invoice `CREATE` and `UPDATE`;
- Contact `CREATE` and `UPDATE`;
- delivery URL: `https://oc.sensible.co.za/api/xero/webhooks`.

The receiver:

1. HMAC-SHA256 verifies the raw request body against `x-xero-signature` using `XERO_WEBHOOK_KEY` with timing-safe comparison.
2. Accepts only Invoice/Contact create/update events with a resource and tenant ID.
3. Hashes normalized event fields into a unique key and inserts it into `xero_webhook_events` with `ON CONFLICT DO NOTHING`.
4. Returns promptly. It does not call Xero during the webhook request.

Invalid signatures return `401`; database/queue failures return `503` so Xero retries. This is intentional: never acknowledge an event that was not durably queued.

The five-minute worker then:

- processes at most 20 unique Invoice resource IDs and 10 Contact resource IDs per run;
- fetches each changed Invoice or Contact by canonical resource URL;
- caches eligible invoice lines, or reconciles permitted Contact people;
- sets `xero_stock_sync_state.refresh_requested_at` for an `ACCREC` invoice, triggering the stock worker; and
- leaves failed events unprocessed with a recorded error for retry.

Xero's invoice collection endpoint has no supported `InvoiceIDs` batch parameter. Do not invent one. The deliberate 20-event cap prevents a webhook burst consuming the daily allowance.

## 7. Background jobs and expected call profile

All production services use `/etc/thanda-store-xero.env`. The templates are in `deploy/systemd/`.

| Unit/timer | Cadence | Xero call behaviour |
| --- | --- | --- |
| `thanda-store-xero-webhooks` | Every 5 minutes | Zero calls with an empty queue. Otherwise changed Invoice/Contact detail reads, capped as above. |
| `thanda-store-xero-stock-webhook` | Every 5 minutes | Zero calls unless a processed customer invoice requested local stock refresh. One full Items read when requested. |
| `thanda-store-xero-stock` | Every 30 minutes | Runs planning sync: one full Items read plus accepted-quote snapshot. |
| Accepted quote snapshot | After 30-minute stock sync | `Status=ACCEPTED`, pages of 100. With one page, 48 calls/day; each additional page adds 48/day. |
| `thanda-store-xero-sales-history` | Daily 06:00 UTC | Reconciliation safety net using `If-Modified-Since`, `DateFrom`, 100-item pages, and only exceptional per-invoice detail reads. |
| `thanda-store-xero-contact-access` | Daily 06:15 UTC | Reconciliation safety net: one contact record read per linked organisation. |

Both stock paths take a shared PostgreSQL advisory lock. Receipt confirmation of a Victron inbound shipment only requests an existing Xero stock refresh; it never increments local stock itself.

### Allowance handling

All jobs that record Xero responses update the single-row `xero_api_usage` table with:

- `x-daylimit-remaining`;
- `x-minlimit-remaining`;
- `x-appminlimit-remaining`;
- rate-limit reason;
- `Retry-After`; and
- a locally calculated `next_allowed_at` after a day-limit response.

The webhook worker preserves a 150-call daily reserve for stock, administration, and reconciliation. When the recorded daily reset is in the future, jobs must exit without calling Xero. On `429`, respect `Retry-After`; do not spin or blindly retry.

User Admin displays the cached allowance. It must never make an API request merely to refresh that display.

## 8. Operational procedures

### Reconnect after expiry or changed scopes

1. Confirm `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, redirect URI, and `XERO_CONNECT_SECRET` are present in the protected VPS environment.
2. Use **Reconnect Xero** in User Admin, or open the protected connect URL.
3. Approve the correct Thanda Solar organisation and all requested scopes.
4. Confirm the callback says the correct tenant connected.
5. Return to User Admin and use **Refresh status**. It must show no missing scopes.
6. Check that the token file remains mode `0600` and that the PM2 web process has `XERO_WEBHOOK_KEY` available.

### Configure or repair webhooks

1. In [Xero Developer app management](https://developer.xero.com/app/manage), configure the delivery URL and Invoice/Contact create/update event categories.
2. Copy the webhook key only into protected server environment. It is not an OAuth credential.
3. Restart PM2 with its environment refreshed, then verify User Admin reports the webhook receiver key as configured.
4. Use Xero's `Intent to receive` action. The endpoint must return success before relying on events.
5. Confirm `thanda-store-xero-webhooks.timer` is enabled and check its journal after a test event.

### Manual recovery commands

Run from `/root/thanda-store/thanda-store` on the VPS, with `/etc/thanda-store-xero.env` loaded by the systemd service rather than pasted into a shell.

```bash
systemctl start thanda-store-xero-webhooks.service
systemctl start thanda-store-xero-stock-webhook.service
systemctl start thanda-store-xero-stock.service
systemctl start thanda-store-xero-sales-history.service
systemctl start thanda-store-xero-contact-access.service

journalctl -u thanda-store-xero-webhooks.service -n 100 --no-pager
journalctl -u thanda-store-xero-stock.service -n 100 --no-pager
systemctl list-timers 'thanda-store-xero-*'
```

Do not use manual runs as a substitute for fixing a failed OAuth connection, a missing webhook key, or an exhausted allowance.

### Safe troubleshooting sequence

1. Read User Admin's cached connection, scopes, webhook-key-present, and allowance state.
2. Inspect the appropriate systemd journal.
3. Check queued webhook rows, sync state, and cached data in PostgreSQL before making another Xero call.
4. If there is an OAuth error, reconnect once; do not repeatedly initiate consent.
5. If a rate limit is recorded, wait through `next_allowed_at` / `Retry-After` and identify the job that consumed the allowance before changing a schedule.
6. Verify an external outcome: updated KZN quantity, saved contact access change, current Home favourite, or Xero draft quote. A 200 response alone is insufficient.

## 9. Database objects created by the integration

The jobs defensively create or evolve these objects. Treat them as operational caches/state, not an alternative accounting ledger.

| Object | Role |
| --- | --- |
| `xero_api_usage` | Latest observed allowance/limit state. |
| `xero_webhook_events` | Durable deduplicated webhook queue, attempts, and errors. |
| `xero_stock_sync_state` | Coalesces invoice-triggered Xero Item refresh requests and records completion. |
| `xero_invoice_sync_state` | Incremental invoice-history reconciliation watermark. |
| `xero_sales_invoice_lines` | Eligible 12-month sales line cache for favourites/popular ranking. |
| `xero_accepted_quote_*` tables | Snapshot and line-level reservation data used by replenishment. |
| `organisations` Xero fields | Contact link and cached display name. |
| `portal_users` Xero fields | Linked primary/additional-person eligibility and archive state. |
| `portal_cart_lines` | Local cart. It contains SKU/product identity and quantity, not trusted price. |

## 10. Tests and verification

Relevant focused tests:

```bash
cd thanda-store
npm run test:xero-accepted-quotes
npm run test:victron-orders
npm run lint
npm run build
```

For a changed Xero integration, also verify:

1. OAuth reconnect succeeds with required scopes.
2. A signed webhook test queues exactly one event and returns promptly.
3. The worker processes it once, not on every timer tick.
4. An invoice update refreshes local stock only through the requested-stock path.
5. A deleted Xero Additional person loses portal access after the event/reconciliation.
6. A buyer cart quote has the expected `ContactID`, `ItemCode`, exclusive VAT amounts, and discount rate in Xero.
7. Rate-limit headers appear in cached User Admin status after an API call, without User Admin itself adding a call.

## 11. Development rules

- Read the OpenAPI specification and API Call Efficiencies guidance before adding a call or parameter.
- Count worst-case calls per run and per day, including pagination and detail fallbacks, before deployment.
- Prefer a webhook plus durable queue when Xero provides that event category.
- Use supported `If-Modified-Since`, dates, filters, ordering, and paging. Preserve a low-frequency reconciliation safety net.
- Keep API calls out of React rendering, page loads, and ordinary catalogue searches.
- Do not loosen webhook signature verification or acknowledge unqueued events.
- Do not log tokens, client secrets, webhook keys, contact PII, or full Xero payloads.
- Keep local cache semantics explicit: cache is for portal speed and bounded API usage; Xero remains the accounting authority.
- Treat quotes, invoices, credit notes, and stock receipt as separate business-state transitions. Add each only with defined ownership, error recovery, and user-visible status.

## 12. Planned follow-up work

- Buyer-visible history of portal-created quotes and their later Xero state transitions.
- Explicit operational design for accepted quotes becoming invoices, declines, unaccepted quotes, fulfilment, and credit notes.
- Reusable BOMs derived from prior Xero quote lines; see [TODO.md](../TODO.md).
- Any new write integration must have idempotency, an audit trail, user-visible failure handling, and a measured Xero allowance budget before it is enabled.
