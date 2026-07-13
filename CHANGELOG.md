# Changelog

All notable production-facing changes are recorded here. This project does not yet use formal releases; entries remain under **Unreleased** until a release process is introduced.

## Unreleased

### Added

- Dealer portal authentication with password plus Resend email OTP.
- Internal user administration for linking buyer organisations to Xero contacts.
- Admin-managed buyer invitations: buyers set their own passwords from a one-use email link, then use email OTP at sign-in.
- Xero contact email lookup in User Admin, with automatic selection for one exact match and an explicit dropdown for multiple matches.
- Admin editing of a portal email clears the organisation Xero link and revokes the changed user's active sessions before rematching.
- Renogy and Victron supplier catalogue synchronization, with a quarterly Victron South Africa SKU allow-list process.
- Xero local/KZN stock synchronization for Victron and LoRa products.
- Category and supplier navigation, progressive product search, product-line support for Renogy, Victron, Hubble and LoRa.
- Server-generated WebP product thumbnails with supplier-image and placeholder fallbacks.

### Changed

- Product cards now distinguish stock available immediately in KZN from supplier warehouse stock and its lead time.
- Buyer pricing is emphasised as **Your Price Excl. VAT**; the non-buying reference price is labelled **List Price Excl. VAT**.
- Thumbnail generation is now lazy and self-maintaining: the first catalogue load that encounters a missing thumbnail queues background generation without delaying the response.
- Generated thumbnails are served through a cached application media route, so they become available without a Next.js restart.

### Security

- Buyer discounts are capped server-side at 40% off the list price.
- The fixed user/password seed command has been removed. User passwords are no longer part of the environment-based operational workflow.

### Known limitations

- Cart and draft Xero quote creation are not yet implemented.
- Hubble availability remains a manual product setting; an administrator control has not yet been built.
- Supplier and Xero sync failures are logged locally but do not yet produce external alerts.
