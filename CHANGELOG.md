# Changelog

All notable production-facing changes are recorded here. This project does not yet use formal releases; entries remain under **Unreleased** until a release process is introduced.

## Unreleased

- Added an optional **PDF datasheet** to Admin → Products. Upload a PDF beside the product photo, open the current file, replace it with a new upload, or remove it when saving. Customers can open it from **Product resources → Datasheet**. The saved PDF survives stock syncs and is included in database backups; replaced or removed links expire. Photo and PDF uploads together can total 8 MB per save.

- Victron catalogue review now shows **Cost changes**, **New products**, **Needs review**, then **Archive candidates**. Each company name shows the total of the first three queues; archive candidates remain separate. The Admin menu orange dot stays visible only while either company has counted work in those queues, including stocked, unignored review candidates. Archive-only, failed or overdue comparisons do not light the dot; data warnings stay on the page. The acknowledgement button has been removed because it cannot clear outstanding work. Counts use the same saved-data calculation throughout and add no provider calls. Xero's official API was rechecked on 8 October 2026: no supported item-archive operation exists.

- **Companies** can now search Xero by company name or primary contact email on demand, choose the matching company, and select which primary or additional people receive Store buyer invitations. A company can also be added without activating anyone. Each search reads current Xero data through the shared Hub; creation rechecks the selected contact and people before saving. Results and email failures are reported individually, and existing Store company records still use their fixed Xero Contact ID. Contact reconciliation waits for newer stored Xero evidence before changing a newly created company's name or revoking its newly invited buyers.

- Catalogue and search results now hide confirmed unavailable products by default, matching Home favourites. A **Show unavailable** switch beside the product count reveals them, including when a search has no available matches. The sidebar's Unavailable filter stays consistent with the switch, unknown stock remains visible, and filtering makes no additional API calls.

- The Victron archive checklist now has separate filters for **Ready for final checks**, **Waiting for supplier evidence**, and **Stock needs checking**, with counts for the selected company. Rows show company stock and archive status instead of irrelevant price columns. A short staff checklist explains current stock, open orders, replacements and recording completion after archiving in Xero. Unknown stock remains blocked, and filtering does not make supplier or Xero calls.

- Product-action pause messages now tell staff exactly when to try again, using short sentences and South African time. A short wait shows the remaining seconds; reaching the daily limit shows the next 02:00 reset date. The message confirms that the paused action changed no products. Daily limits and the wait between actions are reported separately, with matching retry deadlines; the safety limits and provider request counts are unchanged.

- Victron review candidates can now be resolved directly: **Add to Xero** for missing products, **Update** for changed costs, and **Keep in Xero** when an existing item already has the correct cost. Prices are shown before the action, and accepting eligibility advice still enforces price, panel, packaging and purchasing checks. **Ignore for 90 days** keeps an item visible with its expiry while removing it from that company's review count and alerts; **Undo ignore** restores it. Decisions survive comparisons, and expiry returns stocked candidates automatically at the next comparison. Existing price changes and archive checks remain actionable.

- Accounts background imports now accept a newer Hub observation time when the saved content revision is unchanged. Pagination still requires the same complete revision throughout and retains the earliest observation for the collection. This fixes false import failures during ordinary Hub scans without adding provider calls or weakening protection against changed data.

- Repaired Accounts navigation that kept a single-quote restriction when switching tabs or returning to the full account. The restriction now has a clear label and clearing it reloads the history. Removed the confirmation and email promise of an immediate Accounts view. Large history refreshes now run in the existing background worker from complete saved Hub data; the page returns cached documents immediately and shows queued work, source observation and failures. Imports publish in batches atomically, retain the previous history on failure, and protect newer confirmed quotes. HTML timeout responses produce a readable message instead of a JSON parser error, failed reads clear misleading old results, and document dates retain their year. These changes add no Xero or supplier calls.

- Victron **Needs review** now puts products with stock in the ZA warehouse first and counts only those candidates. Zero-stock and unknown-stock products remain visible as silenced, with distinct stock labels, and return to the active list automatically at the next daily or manual saved comparison when stock arrives. Silenced rows do not trigger change alerts; returning candidates alert again. Solar-panel exclusion now uses the `SPM`/`SPP` prefixes consistently, so `SCA` accessories and `SLS` SolarSense are no longer excluded by the broad “Solar panels and cables” category. No additional supplier or Xero calls are introduced.

- Victron new products now have an **Add to Xero** action and the same selection and bulk review workflow as cost changes. Add up to 50 products to one company at a time, with purchase and initial selling prices visible before approval. The shared Hub uses one duplicate check and one create-only batch request; existing items, mixed selections and uncertain outcomes are protected, and every attempt is audited.

- Repaired Victron cost updates after the Hub could fail while reading optional rate-limit headers. Individual and batch submissions now share one audited command path, save the exact attempt before dispatch, and report uncertain outcomes without exposing parser errors. Confirmed updates remain successful if the later audit or comparison refresh fails. Unchanged prices survive supplier timestamp and stock refreshes, while fresh command IDs allow genuine later price cycles. Strict decimal validation rejects malformed or out-of-range supplier prices. The companion Hub repair includes real connector/database regression tests and separates new-product accounting checks from existing cost updates.

- Victron update errors now distinguish changed proposals from mixed-company selections, report how many selected proposals changed, and confirm when no Xero writes occurred. Rejected selections are cleared and the latest saved comparison reloads automatically; updates are never retried automatically.

- Victron cost-change rows now have an **Update** button that applies the displayed cost immediately, with progress and outcome shown on the row. The extra confirmation at the bottom of the page is removed for individual cost updates; batch updates retain their confirmation.

- Missing Victron list prices now fall back to normal E-Order Thanda cost divided by 0.525. The calculated list is labelled in review and creation previews, and supplies Sensible’s list-less-40% cost and new-item selling price. Explicit supplier list prices retain precedence.

- Fixed quote requests that reported “Hub 400” after Xero silently created a draft instead of the configured SENT status. The Admin draft/SENT switch remains; SENT now uses a separate, idempotent status update after draft creation. If either outcome is uncertain, the buyer is told to contact sales with the same reference rather than start another request. Customer copy now describes a quote request accurately for either setting.

- Added a daily Victron catalogue review for Thanda and Sensible. Thanda uses normal E-Order ZAR cost; Sensible uses E-Order list less 40%. Administrators can approve up to 50 purchase-cost changes together or create a missing item, with price rechecks and an audit trail. Existing selling prices, quantities and stock valuation are preserved. Full supplier evidence discovers products outside the Store assortment, excludes South African solar panels, and flags replacement/packaging relationships. In-app change alerts, a manual Xero archive checklist and quarterly sanity-check records complete the workflow. Companion Hub deployment, a dedicated two-company service identity and timer enablement are required; no live changes are made by installing source files alone.

- Moved **Save permissions** below Access level and Manage users on the user editor. It now highlights pending changes, so checking Manage users clearly requires a deliberate save.

- Made Admin → Companies a compact one-row-per-company list. Click a row to expand its pricing and people controls; links to a specific company open the right row automatically.

- Kept the Thanda Store logo and product search at the top of every signed-in portal page. Search still filters the catalogue as you type; from other pages, Enter opens the matching catalogue results. The header stacks neatly on narrow screens, while sign-in and recovery keep their own focused layouts.

- Added a dismissible product-details tip above the catalogue for each signed-in user's first visit on a browser, plus a permanent View details action on each card. Opening a product also dismisses the tip; returning visits stay clear of it.
- Added **Admin menu → Products** to search the saved Thanda Xero products and services, identify items already in the catalogue, and add an unlisted item with a store name, description, category, photograph and selling price. Prices are in rand excluding VAT and are not reduced by company discounts. **Added from Xero** reopens these products for editing or hiding. Store edits and photos survive stock syncs; Xero remains the stock authority and is never changed by this workflow. Search and saves make no Xero API calls, preserve unknown stock, and prevent duplicate item imports.

- Simplified missing-Xero-item review: Create in Xero now opens the saved-price confirmation directly, while Other actions handles checks and stocking decisions separately. Added distinct Needs action, Awaiting Xero sync and Reviewed / archived views with non-overlapping counts. Replacement labels now explicitly say Replaces / Replaced by; accounting details and optional notes stay collapsed until needed. Product creation still requires confirmation and never changes stock quantities.

- Data health now names the safe failure category for new Victron request failures, including redirect, DNS, TLS, connection, timeout and interrupted response. Older failures say their cause was not recorded. Raw errors and tracking URLs stay out of the ledger; this adds no supplier calls.
- Added admin-reviewed creation of missing Victron products in Xero through the shared Hub. A price preview uses normal E-Order cost and cost / 0.525 selling price, excluding VAT. Creation never sends stock quantities or updates an existing SKU; duplicate and uncertain attempts are protected and audited.
- Complete E-Order catalogue scans now archive unavailable predecessors and exhausted "Available until stock 0" products from purchasing and the missing-Xero queue. Reviewed / archived retains the supplier reason and a restore control. Existing Thanda stock, succession relationships, Xero records and sales history are preserved; incomplete scans cannot establish retirement.

- Added the shared Admin menu to Inventory planning so its navigation matches the other admin pages.

- Removed the technical cutover date from the Inbound sync summary. The last sync time and excluded RMA count remain visible; the historical import boundary is unchanged.

- Reduced Victron catalogue checks to every four hours and separated the hourly shipment/backorder timer, so catalogue failures no longer block receiving updates. Added shared database-backed request pacing, persistent scoped cooldowns, bounded request counts and attribution by job/manual action. Data health now shows request activity, returned quota headers and retry deadlines, with a cooldown-protected catalogue retry. Resolved tracking links are cached; existing active cooldowns are preserved across deployment. Supplier stock freshness now allows five hours between observations; real unknown quantities remain unknown.

- Sign-in, password reset and password setup now remain accessible when a browser retains an expired session cookie. Previously, the cookie's mere presence redirected recovery back to the store before a reset request could be submitted.

- Removed live E-Order product lookups from provisional-cart uploads. A supplier outage or rate limit no longer blocks a saved HTML cart: all valid lines are retained atomically, replacement-family matches count toward coverage, and unmatched SKUs remain visible with resolution guidance until the local catalogue can match them.

- Login-code emails now include a Gmail-friendly preheader, isolated six-digit code and a clean visual code card for email clients without a native copy action. The sign-in page focuses the field after a code is sent and automatically verifies a complete typed or pasted code.

- Replenishment now keeps source-wide sync and freshness warnings in Data health instead of repeating them on every item. Row warnings identify missing item quantities or overdue inbound balances; operational statuses and withheld unknown recommendations are preserved. A New changes badge highlights changed health issues and is acknowledged by opening the section for the current browser tab session, without extra supplier calls.

- Replaced the isolated Back to store link on API access with an account menu for Store, Accounts, API access, Admin when permitted, and Logout.
- Made customer API access discoverable for every signed-in user from the Store and Admin menu. The page explains when an administrator still needs to enable access; the user editor now links to the signed-in account's key and guide page without implying an admin can create another person's secret.
- Removed global Xero status from the Edit user page; it remains in Admin Settings. The editor now moves from company and email to permissions, customer API access and account actions. The Admin menu groups destinations by people and sales, stock and planning, and system settings, and the Add user form now sits above the user list like Add company does on Companies.
- Added a missing-Xero-item review queue in Data health. Administrators can acknowledge an item as Do not stock or No longer supplied by Victron, record a reason, review the replacement family, and undo decisions. Add in Xero guides the bookkeeper to create the item; Check Xero item imports its latest complete saved Hub observation and reports whether it is absent, untracked or tracked. Decisions are audited, survive catalogue syncs, and never delete history or override real Xero stock.
- Kept Replenishment's Order, Top up, Partial, Satisfied and Covered statuses visible when saved data carries warnings. A compact warning icon opens a separate explanation, avoiding stretched table rows. Data health now lists searchable affected SKUs, explains how to resolve missing Xero items, untracked inventory, missing supplier observations and rate limits, and provides navigation and downloadable diagnostics for follow-up. Required unknown quantities still withhold a recommendation rather than assume zero.
- Aligned the User Admin table with shared fixed desktop columns and replaced row action text with monochrome icons for customer view, invitation, password reset and editing. Icons retain accessible names and hover titles.
- Fixed administrator View as behind the production proxy: the route now checks the browser's origin against the configured public Store URL, or the Store's public default, instead of the internal localhost URL. Setup-pending active buyers remain eligible; no customer password or setup token is needed.
- Moved the Add a company form above the company search and list so it is immediately available on the Companies page.
- Added a guarded Store deployment command that checks production health, Git and PM2 state, prevents overlapping deploys, stops Next before rebuilding, verifies the page and stylesheet, and restores the previous build if deployment fails. PM2 now starts Next directly without file watching, avoiding orphaned servers on port 3000.
- Replaced the wrapping links in admin page headers with a compact Admin menu. It marks the current page and closes on selection, outside click or Escape.
- Removed the operational stock-source status panel from the customer storefront. Product-level availability remains visible; sync warnings and source timestamps remain in Admin → Data health.
- Creating a company now creates and invites its primary Xero contact in the same onboarding action. The company and buyer are saved together; an email failure is reported with a direct path to resend. Existing companies have an **Invite primary contact** action, including Mersat-style records created before this change.
- Kept the Store light-only on devices that prefer dark mode. Data health now uses the same light admin surface and readable card, timestamp and button text as the other admin pages.
- Condensed the Replenishment page controls. Overdue inbound receipts remain prominent; planning-data issues show their counts with expandable source details, while policy, accepted-quote checks and provisional-cart upload open on demand. The recommendation table now starts much higher on the page.
- User managers can temporarily **View as** an active buyer from User Admin to build that buyer's cart and request a quote using the buyer's company pricing and Xero contact. A persistent banner names both identities and returns to Admin; the view expires after one hour. Start/stop actions and quotes retain the acting administrator in the audit trail, while API-key changes are blocked during customer view.
- Added **Add company** and **Add user** shortcuts to User Admin. The detailed Xero connection panel and quote creation control now live under **Settings**, with a compact Xero connection indicator beside the shortcuts. The indicator distinguishes an unavailable status check from a confirmed connection.
- Added **Admin → Companies** for shared Xero identity, discounts and people. Personal email changes validate against the existing company and no longer unlink colleagues. Explicitly moving one person to another company revokes that person's sessions and keys, disables their API access and clears their cart; company pricing and other members remain intact. Existing company identities cannot be silently repointed from a personal editor. Changes are audited and user-management permissions still apply.
- Coordinated login, password setup and API-key creation with personal identity changes. In-flight requests now recheck the user under the same lock, so revoked credentials cannot be recreated after an email or company move. OTP consumption and session creation are atomic, and resending a code invalidates older unused codes.
- Replaced the permanent **Warehouse Live** label with source-specific stock update times and warnings for unknown, overdue or failed updates. Unknown stock is distinct from confirmed zero, including Xero missing/untracked items, and has its own catalogue filter. Failed catalogue/favourites loads now show Retry instead of empty results.
- Added **Admin → Data health** with local source observations and sync outcomes. Replenishment withholds quantities when required evidence is missing, keeps stale calculations visibly provisional, explains affected replacement families and sorts unknown values separately. Status checks and job instrumentation add no supplier or Xero calls.

- Moved the mobile header navigation into a hamburger menu, leaving the brand and product search visible. Company details, Accounts, API access, Inventory, Admin, Cart and Logout retain their existing access rules. The menu closes after selection, outside clicks, Escape or returning to desktop size; desktop navigation remains inline, with enough header height when a long set of links wraps.

- Added a customer API guide under **API access**, with setup examples, field definitions, pagination, change detection and error recovery. API-enabled customers can download the same guide as Markdown or a standard OpenAPI JSON specification for their developer or AI assistant. Guide and downloads require a signed-in, API-enabled, company-linked user and contain no real keys or customer data.

- Quote requests now retain a durable request ID across retries. The successful Hub response, Accounts entry, cart update and notification jobs are saved together. Customer-submitted drafts appear as **Quote requested**, with a direct Accounts link; internal staff drafts stay hidden. The confirmation reports notification status accurately instead of claiming an email was sent after a failure.
- Added bounded email retries and delivery checks independent of quote creation. Sales can review unresolved quote requests and notification failures under **User Admin → Quote requests & notifications**.
- Moved supplier discounts from individual portal users to the linked Xero company/contact. Company users, carts, quotes, CSV and API exports now share the same pricing. Migration stops if existing users have conflicting effective discounts.
- Added a product-details drawer with stored descriptions, specifications, stock and public manufacturer resources. Missing information stays unset; private supplier portal links are not shown. Reviewed RS product-page links supplement existing supplier-provided datasheets and manuals.
- Added a read-only `/api/v1/products` endpoint and matching CSV export with company prices excluding VAT, separate stock sources, successor SKUs, timestamps, pagination, ETags and rate limits. Administrators enable access per user; enabled users generate and revoke their own keys. Secrets are shown once and stored only as hashes. API, CSV and detail reads make no supplier or Xero calls.

- Separated solar panels from cables using supplier subcategories and the actual item being sold. Cables and electrical adapters from Miscellaneous, monitoring and charger groups now appear together under **Cables & connectors**; identifiable mounts, sensors and other accessories have their own category. Original supplier categories and Renogy range eligibility are preserved.
- Renamed **Length** to **Cable length**, corrected decimal-comma parsing (`0,3m` is 0.3 m; `1,8 m` is 1.8 m), and stored lengths numerically. Added cable/adapter/connector type, cable family and separate conductor-size filters. Panel dimensions and included equipment leads no longer supply cable filters; actual panels receive their rated-power filters.
- Added a before/after classification report and persistent, reason-backed product exceptions that survive supplier syncs. Uncertain products remain unguessed. The cleanup uses cached catalogue data with no additional supplier or Xero calls and preserves the 450 V RS filters.

- Added **450 V** to maximum PV voltage filtering for SmartSolar MPPT RS 450/100 and 450/200, Multi RS Solar, and Inverter RS Smart Solar. The non-solar Inverter RS and accessories remain excluded; existing catalogue data is corrected locally without supplier or Xero requests.

- Stock, accepted-quote reservations and customer document records now preserve the Hub's source observation time; reading cached evidence cannot make old source data appear newly observed.
- Added breathing room between filter counts and the sidebar scrollbar, with consistently aligned count columns in the desktop sidebar and mobile drawer.

- Moved all Xero API requests and OAuth credentials into the shared Xero Hub on app-01. Existing stock, quote reservations, customer documents and purchase-history jobs now project stored Hub evidence without consuming Xero calls.
- Routed deliberate quote and PDF actions through authenticated Hub commands with customer ownership and idempotency checks. Signed webhooks are durably forwarded; allowance monitoring now reports the shared connector.
- Retained current product rules and schedules, and added completeness/revision checks so partial or changing collections cannot replace complete local snapshots. See `docs/xero-hub.md` for deployment and recovery.

- Replaced horizontally scrolling product categories with a desktop sidebar and a mobile **Categories & filters** drawer. Category counts, the current category, removable filter chips, and clear empty-result guidance make narrowing the catalogue easier.
- Added category-specific specifications and separate **Thanda stock**, **Supplier stock**, and **Unavailable** filters. Multi-voltage products match each recorded voltage; unknown specifications remain unset. Unavailable catalogue items remain discoverable without hiding their categories.
- Supplier catalogue syncs now save structured filter attributes and their source. Existing products work immediately from cached data, with a dry-run-first local backfill command to persist attributes. Filtering and backfill add no supplier or Xero calls.

- User managers can now send an active portal user a dedicated password-reset email directly from the User Admin directory.

- Fixed the **Forgot password?** link being redirected back to sign-in before the reset form could load.

- Added an administrator-controlled **Send quotes as drafts only** switch. It defaults on; turning it off creates new customer cart and copied quotes as `SENT` in Xero for controlled email-delivery testing.

- Creating a customer quote now emails `sales@thanda.solar` with the company, portal user, and Xero quote reference. It also emails the customer from `sales@thanda.solar` to acknowledge their requested items and explain that sales will send the final quotation shortly. This covers both cart quotes and copied quotes. Email failures never prevent a successfully created Xero draft from completing.

- Expanded buyer setup emails with an accurate overview of the Victron catalogue, Renogy solar panels and batteries, and the portal's catalogue, favourites, quote, and Accounts features.

- Added a zero-Xero-call five-minute allowance monitor. It writes a durable VPS-local `runtime/CODEX_ALERTS.md` with `OK`, `WARNING`, or `CRITICAL` status and a source breakdown for future Codex production work.

- Reduced Xero customer-document refreshes from a 15-minute browser-triggered cache to a six-hour safety-net cache, with a 30-minute per-customer manual refresh cooldown. Invoice and credit-note webhooks remain the primary freshness path.
- Hardened concurrent authentication-schema initialisation and added a local, zero-Xero-call daily API-usage breakdown to User Admin.
- Added a mandatory external-API budget review rule covering cold-cache, backfill, scheduled, retry, cache-invalidation, reserve, and stop-threshold costs.

- Declared Xero's official OAuth scopes reference as the sole authority for scope selection and validation. Historic tokens, OAuth errors, SDK constants, OpenAPI annotations, and examples must not be used to infer permissions.

- Removed the unused Xero Reports permission; customer statements are generated from the protected local document snapshot.
- Added a durable Xero API-usage ledger by source and protected customer-document PDF retrieval with the same daily reserve used by account refreshes.
- Restored global Xero connection status and **Reconnect Xero** to the User Admin directory for every authenticated administrator; user-management actions remain permission-gated.
- Added clearer reconnect handling and safe Xero correlation logging when authenticated customer-document PDF retrieval fails.

- Accounts refreshes now retain the local historical snapshot and use Xero `If-Modified-Since` reads to fetch only changed customer quotes, invoices, and credit notes. Changed statuses are upserted locally, so documents move in and out of Current without reloading the full historic account.
- Account document and due dates now show an explicit year, avoiding ambiguity for customers with multi-year purchase histories.
- Quotes can now be copied to a reviewed new draft quote. The quote-only editor resolves retired Victron SKU lines through the replacement table, supports quantity edits and progressive current-catalogue SKU search, then recalculates current customer pricing and stock-aware fulfilment before creating a new Xero draft. The original quote remains unchanged and each copy action is audited.
- Accounts tabs now read Current, Quotes, Invoices, Credit notes. Removed the generic Credit available card because the Xero contact API does not provide sufficient credit-limit data to show it truthfully.
- Accounts now pages customer documents newest-first instead of rendering the entire history. It shows 25 rows per page and offers progressive partial search across document numbers and references, using the local protected snapshot rather than additional Xero calls.
- Added a buyer **Accounts** dashboard with protected company-scoped Xero quotes, invoices and credit notes, authenticated document PDFs, and a CSV statement download. It caches each customer snapshot for 15 minutes, rate-paces refreshes, retains the shared Xero allowance reserve, and records account listings, document views, statement downloads, and quote actions in the portal activity log.
- Buyers can accept only `SENT` Xero quotes and can return an `ACCEPTED` quote to `SENT` from Accounts. The server re-checks the quote's Xero contact before every status change.
- User Admin is now a searchable user directory with a dedicated edit page for each account. The directory no longer renders every account's access, Xero-link, email, and people-management controls at once; invitations remain available to user managers below the listing.
- Replenishment demand now uses net invoiced quantities: authorised/paid customer credit notes offset their matching SKU sales within the 30- and 90-day windows. The first deployment backfills the prior year of credit notes; future changes are handled incrementally and, where configured in Xero, through `CREDITNOTE` webhooks.
- Added a developer Xero integration handoff covering OAuth, webhooks, schedules, cache ownership, rate-limit discipline, quote creation, recovery procedures, and unimplemented workflow boundaries.
- User Admin now distinguishes ordinary administrators from administrators with **Manage users** permission. All administrators retain Admin and Inventory access; only user managers can invite people, change roles or user-management permission, edit user setup, or enable/disable accounts. Existing administrators are seeded as user managers during the one-time migration so access cannot be lost.
- Fixed the User Admin invite email field losing focus after every character. Changing the email now clears only any stale Xero contact match while leaving the input mounted and ready for uninterrupted typing.
- Replenishment now subtracts Victron quantities reserved on current accepted Xero quotes from the available stock position. A cached purple **Reserved** column groups retail and replacement SKU families, identifies the contributing quote/customer on hover, and can be refreshed with **Check accepted quotes**. The production planning timer refreshes the snapshot every 30 minutes; RMA quotes and stale accepted statuses are explicitly excluded and reported.
- Victron shipment invoices and backorders now synchronize from the E-Order API, replacing inbound PDF and backorder HTML uploads. Imports are idempotent, exclude RMA references, preserve manual full/partial receipt, remove unreceived legacy cart/backorder lines that were never billed for shipment, avoid inbound/backorder double counting, and leave Xero as the only KZN stock authority.
- Buyers can resend their email login code from the verification step after a 30-second cooldown.
- Added an administrator-only Victron inbound-stock workflow. It optionally reads and retains Victron tax-invoice PDFs, prepares a reviewable SKU/quantity list, records line-by-line physical receipt, and requests the existing Xero stock reconciliation without changing Xero inventory directly.
- Added the administrator-only Victron **Replenishment** report. It uses cached 30/90-day invoice sales, current KZN stock, and open inbound quantities to show days of cover, reorder points, and suggested order quantities without making a live Xero or Victron request.
- Seeded Victron stock-minimum settings once from the supplied stock sheet. Administrators now maintain those values in **Inventory planning → Stock minima**; the replenishment report uses the configured minimum as a hard floor alongside demand-based cover. No recurring spreadsheet import is used.
- Renogy authentication now documents the intended token-cache keepalive model: no Renogy username or password is stored on the VPS, and an expired session requires a deliberate email-OTP login.

### Changed

- Draft-quote requests now send an explicit quote date and a stable idempotency key to Xero. Retrying an unchanged checkout cannot create a duplicate draft, and rejected quote validation details are recorded safely in the server log for diagnosis.
- Login-code emails now include the six-digit code in the subject line for easier copying from an email notification.
- Shortened the Replenishment table headers to **Stock**, **Quotes**, **Cart**, and **Cover**, and reduced the table minimum width so the full planning view fits more comfortably on a desktop screen.
- Replenishment table columns can now be sorted by clicking their headers. KZN stock remains visually highlighted, an administrator can click a Min value to update its saved stock minimum directly, and its floating header row remains opaque while scrolling.
- The **Provisional E-Order cart** panel now uses the same mustard colour treatment as the Replenishment table's **Provisional** column.
- Replenishment sales columns no longer inherit the Min highlight. Solid separators now distinguish 90-day sales from Min, Days cover from Suggested, and Suggested from Status; the table header also meets its rounded top corners cleanly.
- The **Item to order** header now opens a progressive SKU/name filter when its text is clicked (or with `/`); the remaining header space continues to sort the column.
- Replenishment demand thresholds now round to the nearest whole unit rather than always upward, avoiding an extra unit for small fractional requirements.
- Administrators can upload a saved Victron E-Order basket HTML file as a transient provisional cart. Its quantities are audited against the replenishment list, can be replaced or cleared, and reduce only the remaining suggested quantity; no source HTML or supplier order is retained.
- Saved Victron E-Order Backorders pages can be imported as a transient replenishment snapshot without creating or updating permanent inbound orders.
- Victron Backorders are now a replaceable, clearable transient snapshot, stored separately from permanent inbound orders and shown in their own orange replenishment column. Replenishment hides the order-point column, exposes 7-day and 14-day targets through Suggested tooltips, and includes a **How recommendations work** tab.
- The **Inbound** page now preserves the supplier order numbers in the transient Backorders snapshot and displays those orange backorder cards above ordinary inbound orders in **Expected orders**. Each backorder line can be cleared individually, while the upload controls retain a global **Clear backorders** action; there is no clear-all action on an individual order, and backorders cannot be accidentally received as inbound stock.
- Inbound stock lines now support **Confirm all** or **Confirm partial** receipt. A partial receipt adds only the counted quantity and keeps the unreceived balance open.
- A red **Order** status identifies an outstanding recommendation. Provisional cart quantities show blue **Satisfied** when they cover the displayed suggestion, or amber **Partial** when they only partially cover it. The former manual Done workflow has been removed: recorded inbound deliveries, stock and sales are the sole inputs to replenishment.
- A provisional Victron cart SKU ending in `R` now fulfils the corresponding non-`R` replenishment SKU, reflecting its retail-packaging-only distinction.
- Replenishment now identifies rows whose demand includes historic sales under predecessor SKUs. Victron SKU succession remains the single source of truth for this grouping, with a regression test for `PMP482305010 → PMP482305012`.
- Administrators can add a previously unknown Victron predecessor SKU from the matching successor's replenishment row, without overwriting an existing conflicting relationship.
- The optional `+ Details` action is now hidden until its replenishment row is hovered or keyboard-focused, matching `+ Note` and reducing visual noise.
- Provisional-cart matching now prefers an exact SKU before applying the `R` packaging fallback, so an exact retail SKU is not incorrectly reported as unmatched.
- A cart HTML upload now imports any previously unknown SKU directly from Victron E-Order before using that line in the replenishment audit.
- Corrected Renogy list-price VAT handling: the authenticated product API's `originalPrice` is already excluding VAT, while the partner portal displays it including VAT. Renogy buyer prices now apply the B2B discount directly to the Excl. VAT list price.
- Customer Invoice webhooks now request a debounced Xero Items refresh, so KZN stock normally updates within ten minutes instead of waiting for the 30-minute reconciliation timer. The request worker makes no Xero call when no invoice changed, cannot overlap another stock sync, and records API allowance headers.
- Raised the red `Not available` ribbon above product stock/category badges and disabled ordering for items with no KZN or supplier stock. The cart API now enforces the same rule.
- Victron `If 0, order <SKU>` description markers now link predecessor and successor SKUs for Home ranking while preserving each historical SKU as a separately visible card while it remains stocked.
- Victron cart and quote fulfilment now prefer a stocked older SKU in a replacement family; when no older SKU has stock, the current successor SKU is used for procurement. Quote lines resolving to the same SKU are consolidated.
- Fixed Home favourites ranking after the SKU-succession change by normalizing PostgreSQL invoice dates before sorting.
- Explicit Victron replacement SKUs are now included in the catalogue even when omitted from the quarterly price-list allow-list, and Home prefers the newest orderable family member.
- Split supplier scheduling: Renogy remains five-minute, while Victron's paginated catalogue sync is hourly and rate-paced to prevent repeated E-Order `429` responses.
- Victron successor SKUs without their own supplier image now temporarily display their predecessor's image or thumbnail, automatically reverting to the successor image when it becomes available.

### Added

- Buyers can request a one-use password-reset link from the sign-in page without exposing whether an email address has a portal account.
- Dealer portal authentication with password plus Resend email OTP.
- Internal user administration for linking buyer organisations to Xero contacts.
- Admin-managed buyer invitations: buyers set their own passwords from a one-use email link, then use email OTP at sign-in.
- Xero contact email lookup in User Admin, with automatic selection for one exact match and an explicit dropdown for multiple matches.
- Admin editing of a portal email clears the organisation Xero link and revokes the changed user's active sessions before rematching.
- Email-only portal authentication: usernames have been removed before launch.
- Xero-backed company access: the primary contact is the first login, additional people can be explicitly enabled, and a scheduled reconciliation archives enabled people removed from Xero.
- Saved Xero contact links now collapse into a locked summary until an administrator explicitly chooses to edit them.
- The internal `sales@thanda.solar` mailbox is excluded from Xero Additional people portal access.
- Company names are now Xero-owned: buyer invite no longer accepts a company-name field, and linked organisation display names refresh from Xero.
- Password setup now replaces the password form with a sign-in action that carries the account email into the login page.
- Renogy and Victron supplier catalogue synchronization, with a quarterly Victron South Africa SKU allow-list process.
- Xero local/KZN stock synchronization for Victron and LoRa products.
- Category and supplier navigation, progressive product search, product-line support for Renogy, Victron, Hubble and LoRa.
- Server-generated WebP product thumbnails with supplier-image and placeholder fallbacks.
- A server-backed cart, Home favourites, draft Xero quote creation, and a derived Xero sales-history cache for ranking favourites.
- HMAC-verified Xero Invoice and Contact webhook ingestion with a durable PostgreSQL queue and a bounded systemd worker.

### Changed

- Product cards now distinguish stock available immediately in KZN from supplier warehouse stock and its lead time.
- Buyer pricing is emphasised as **Your Price Excl. VAT**; the non-buying reference price is labelled **List Price Excl. VAT**.
- Thumbnail generation is now lazy and self-maintaining: the first catalogue load that encounters a missing thumbnail queues background generation without delaying the response.
- Generated thumbnails are served through a cached application media route, so they become available without a Next.js restart.
- Home is the first catalogue tab. It offers `My favourites` from the linked Xero customer's last 12 months of authorised/paid SKU invoice history and `Popular` from total units sold across all current catalogue SKUs.
- Cart prices and discounts are recalculated from the current catalogue when read and again when a draft quote is created. A successful checkout creates an exclusive-VAT Xero draft quote and clears the cart; a rejected request retains it.
- The customer-facing cart command is labelled **Quote me!**; it creates only a draft quote at this stage.
- User Admin now displays the latest observed Xero API allowance and the sales-history timer pauses cleanly through a Xero daily-limit `Retry-After` window.
- Xero Invoice/Contact routine polling has been replaced by webhook-driven updates; the old jobs are now daily `If-Modified-Since` reconciliation only.
- Xero webhook invoice processing now uses only the documented per-invoice resource endpoint, with a 20-invoice run cap; unsupported collection batching cannot clear the sales-history cache.
- Home favourites now filter retired historical SKUs before applying their visible ranking limit, so current catalogue products are not crowded out by old item codes.
- The Xero webhook worker now reserves 150 daily API calls, pausing queued work before an event burst can exhaust the tenant allowance.
- Xero integration changes now require verification against the official OpenAPI 3 repository and Xero's API Call Efficiencies guidance before implementation.
- Victron and Renogy zero supplier stock no longer show a delivery promise; cards now state `Out of stock / not available` unless immediate KZN stock exists.
- Unavailable supplier-backed products now carry a prominent diagonal red `Not available` ribbon without obscuring products held in KZN.
- Developer and operational documentation now require API-budget estimates, batch/incremental reads, cached portal data, bounded backfills, and strict `429`/`Retry-After` handling for all external integrations.

### Security

- Buyer discounts are capped server-side at 40% off the list price.
- Supplier sync credentials now belong in a root-only systemd `EnvironmentFile`, rather than service-unit definitions.
- The fixed user/password seed command has been removed. User passwords are no longer part of the environment-based operational workflow.

### Known limitations

- Hubble availability remains a manual product setting; an administrator control has not yet been built.
- Supplier and Xero sync failures are logged locally but do not yet produce external alerts.
