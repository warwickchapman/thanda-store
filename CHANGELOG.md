# Changelog

All notable production-facing changes are recorded here. This project does not yet use formal releases; entries remain under **Unreleased** until a release process is introduced.

## Unreleased

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
