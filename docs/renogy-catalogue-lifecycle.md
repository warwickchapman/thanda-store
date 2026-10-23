# Renogy catalogue membership

The scheduled Renogy sync records whether each saved Renogy article appears in
the latest complete supplier warehouse export. This uses the export already
downloaded by the stock job; it adds no supplier or Xero requests.

`details.cataloguePresent` is a boolean and `details.catalogueObservedAt` is the
export-download time. The export must contain the expected columns and at least
one valid, unique article code. Failed downloads, empty exports, malformed CSV,
duplicate article codes and local test CSV files do not replace the last valid
membership evidence.

Membership is recorded in one atomic database update before individual product
searches and detail updates. A successful export still establishes membership
when a later product-detail request fails. Listed products without a successful
detail refresh keep their last stock observation and remain stock-data issues.

An absent article needs a lifecycle decision. Absence does not prove that its
physical stock is zero or that the manufacturer discontinued it. Existing stock
quantities, their observation times, hidden state and editorial metadata are
retained. Data health separates these articles from stock-update faults and
links to product management. Confirmed replacement relationships still come
from `renogy_sku_successions`; similar names and generation numbers do not
establish a replacement.

The API budget is unchanged: one identity request, three shared export/download
requests, and the existing SKU search/detail requests (`4 + 2N`, before any
existing image-signing or authentication recovery requests). No Xero writes,
extra timer or provider probes are introduced.

Verification:

```bash
cd thanda-store
node --test test/renogy-catalogue-lifecycle.test.mjs test/renogy-stock.test.mjs
RUN_RENOGY_STOCK_DB_TESTS=1 DATABASE_URL=<local-disposable-database> node test/renogy-stock-sync.integration.mjs
```

The integration check uses a fake Renogy server and an isolated PostgreSQL
schema. It checks request counts, present/absent membership, retained stock and
editorial fields, invalid-export preservation, and the local-CSV boundary.
