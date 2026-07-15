# Changelog

All notable production-facing changes are recorded here. This project does not yet use formal releases; entries remain under **Unreleased** until a release process is introduced.

## Unreleased

### Changed

- Raised the red `Not available` ribbon above product stock/category badges and disabled ordering for items with no KZN or supplier stock. The cart API now enforces the same rule.
- Victron `If 0, order <SKU>` description markers now link predecessor and successor SKUs for Home ranking while preserving the card and Xero quote SKU that is actually ordered.

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
- The fixed user/password seed command has been removed. User passwords are no longer part of the environment-based operational workflow.

### Known limitations

- Hubble availability remains a manual product setting; an administrator control has not yet been built.
- Supplier and Xero sync failures are logged locally but do not yet produce external alerts.
