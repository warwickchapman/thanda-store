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

### Xero-specific contract and efficiency rules

- Before changing any Xero request, consult the official [Xero OpenAPI 3 specification repository](https://github.com/XeroAPI/Xero-OpenAPI). Do not infer unsupported query parameters, request shapes, or batching behaviour from SDK snippets, older examples, or memory.
- Follow Xero's [API Call Efficiencies](https://developer.xero.com/documentation/getting-started-guide/) guidance as a design requirement: webhooks where available, derived local data for portal reads, smart filtering, `If-Modified-Since`, pagination, caching, and deliberate low-frequency reconciliation.
- Confirm a proposed Xero request against the applicable OpenAPI operation before deployment. Record the endpoint, supported parameters, expected calls per run/day, and fallback behaviour in the relevant README section or code comment.
- Treat the Xero tenant allowance as shared across webhooks, stock, history, contact access, quote creation, and admin actions. Preserve the configured reserve; do not spend it on speculative probes or repeated recovery attempts.
