<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## External API budget discipline

External API calls are a constrained production resource. Minimise them by default.

- Never make an external API request from a storefront render, client polling loop, or administrative page load unless the user explicitly requested a live action.
- Read from PostgreSQL-backed derived data in normal portal flows. Sync external data in scheduled jobs and record when it was last observed.
- Use provider-native incremental mechanisms first: `If-Modified-Since`, cursor/page tokens, date windows, webhooks, and batch endpoints. Do not fetch one record per request when a batch request exists.
- Before adding or changing an integration, state the expected calls per run, calls per day, and the provider limit. Keep a safety margin for existing jobs and interactive admin actions.
- Persist the latest available quota/rate-limit headers where the provider supplies them. Surface the cached allowance and retry deadline in Admin; do not spend a request merely to refresh a dashboard number.
- Honour `429` and `Retry-After` exactly. When a daily allowance is exhausted, record the next permitted attempt and make scheduled runs skip locally until then.
- Initial backfills must be resumable, bounded, and safe to pause. They must not retry indefinitely or exhaust a daily budget in one run.
- New API code must have request timeouts, bounded retries, useful error logs without secrets, and a test or manual verification plan for rate-limit behaviour.

## Victron SKU succession contract

`victron_sku_successions` is the single source of truth for Victron article-code replacements. It is populated by the Victron catalogue sync from explicit `If 0, order <SKU>` supplier markers.

- Before adding or changing logic that compares, groups, totals, displays, fulfils, quotes, carts, orders, stocks, or analyses Victron SKUs, query this table and decide whether the operation applies to a whole replacement family rather than one literal SKU.
- Do not introduce a second replacement map, hard-coded SKU substitution, or inferred successor rule. Reuse the shared family resolver, while treating an `R` suffix as retail packaging for the same stock item.
- Where a result aggregates historic predecessor activity into a current successor, expose that relationship when it would help an operator audit a purchasing decision.
- Add a regression test for each new succession-sensitive workflow. The canonical example is `PMP482305010 → PMP482305012`: historic sales under the predecessor must contribute to demand for the successor.

### Xero-specific contract and efficiency rules

- Before changing any Xero request, consult the official [Xero OpenAPI 3 specification repository](https://github.com/XeroAPI/Xero-OpenAPI). Do not infer unsupported query parameters, request shapes, or batching behaviour from SDK snippets, older examples, or memory.
- For OAuth scope selection and validation, use only Xero's official [OAuth 2.0 scopes reference](https://developer.xero.com/documentation/guides/oauth2/scopes/). Do not infer scope names, availability, or permissions from old tokens, error messages, SDK constants, OpenAPI annotations, or third-party examples.
- Follow Xero's [API Call Efficiencies](https://developer.xero.com/documentation/getting-started-guide/) guidance as a design requirement: webhooks where available, derived local data for portal reads, smart filtering, `If-Modified-Since`, pagination, caching, and deliberate low-frequency reconciliation.
- Confirm a proposed Xero request against the applicable OpenAPI operation before deployment. Record the endpoint, supported parameters, expected calls per run/day, and fallback behaviour in the relevant README section or code comment.
- Treat the Xero tenant allowance as shared across webhooks, stock, history, contact access, quote creation, and admin actions. Preserve the configured reserve; do not spend it on speculative probes or repeated recovery attempts.
- Every new or changed external-API feature requires an API budget review before implementation: identify every request path, cold-cache/backfill cost, scheduled daily cost, retry behaviour, cache invalidation source, reserve impact, and the threshold at which it must stop. Record this assessment in the relevant README section or code comment. A feature with unbounded customer-triggered requests must be redesigned before deployment.
- API monitoring is part of the feature: every Xero response must retain its source and returned allowance headers in the local usage ledger; User Admin must expose the daily source breakdown without making a Xero call. Treat a sharp source increase or remaining allowance below the protected reserve as an operational incident, pause non-essential work, and investigate before adding calls.
- Before any production Xero investigation, deploy, recovery, or manual sync, read `/root/thanda-store/runtime/CODEX_ALERTS.md` over SSH. It is written locally every five minutes and does not consume a Xero call. A `WARNING` or `CRITICAL` status blocks non-essential Xero work until investigated.
