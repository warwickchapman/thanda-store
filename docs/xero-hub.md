# Shared Xero Hub

All outbound Xero requests and token refreshes now belong to [Xero Hub](https://github.com/Sensible-Solar/xero-hub). Configure XERO_HUB_URL and XERO_HUB_TOKEN in the app and existing scheduled-job environment. On app-01 the URL is http://127.0.0.1:8010. Keep the existing Xero webhook signing key to verify and forward signed deliveries; it is not an API credential.

The Thanda service identity permits only thanda-solar. The portal still checks signed-in users and their linked Xero customer before sending actor/contact context for quote or PDF commands. Normal catalogue/admin pages read application projections or stored Hub evidence. Explicit quote/PDF operations may cause an audited Hub request. OAuth management redirects authorised administrators to Sensible Cloud.

Stock/planning remains on the 30-minute timer, webhooks on five-minute workers, and history/contact reconciliation on existing daily timers. These jobs consume no Xero allowance; the Hub owns synchronisation, freshness and rate-limit handling. Full stored collections are validated before replacing snapshots. Customer document caching and SKU-family rules are unchanged.

Remove XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_TOKEN_PATH and active token files after cutover. API allowance status and CODEX_ALERTS now use the Hub ledger. The shared service API and its operations document define complete source data, observed history, unknown quote outcome recovery and rollback precautions. Never restore old refresh tokens while the Hub is running.
