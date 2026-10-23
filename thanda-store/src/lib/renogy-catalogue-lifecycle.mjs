import { parse } from 'csv-parse/sync';
import { observationTime } from './data-freshness.mjs';

const normaliseSku = value => String(value || '').trim().toUpperCase();

function validCatalogueRows(rows, observedAt) {
  const timestamp = observationTime(observedAt);
  if (!timestamp || !Array.isArray(rows) || rows.length === 0) {
    throw new Error('An empty or unobserved Renogy export cannot establish catalogue membership.');
  }
  const skus = new Set();
  for (const row of rows) {
    const sku = normaliseSku(row.SKU);
    if (!/^[A-Z0-9][A-Z0-9._-]{0,149}$/.test(sku) || skus.has(sku)
      || row.source !== 'renogy-export' || observationTime(row.stockObservedAt) !== timestamp) {
      throw new Error('An invalid or duplicate Renogy export article cannot establish catalogue membership.');
    }
    skus.add(sku);
  }
  return { skus: [...skus], observedAt: timestamp };
}

// Only the complete supplier download establishes membership. A local CSV or
// a failed/empty/malformed response must never retire retained Store products.
export function parseRenogyCatalogueExport(csv, observedAt) {
  let headers = [];
  const parsed = parse(csv, {
    bom: true, trim: true, skip_empty_lines: true,
    columns: columns => { headers = columns; return columns; },
  });
  if (!['Item No', 'Item Description', 'Available'].every(header => headers.includes(header))
    || new Set(headers).size !== headers.length) {
    throw new Error('Renogy export is missing its expected catalogue columns.');
  }
  const rows = parsed.map(row => ({
    SKU: normaliseSku(row['Item No']), Description: row['Item Description'],
    Stock: row.Available, InTransit: row['In transit'],
    ExpectedDeliveryDate: row['Expected Delivery Date'],
    source: 'renogy-export', stockObservedAt: observationTime(observedAt),
  }));
  validCatalogueRows(rows, observedAt);
  return rows;
}

export function renogyCatalogueMembershipDetails(row) {
  return row.source === 'renogy-export' && observationTime(row.stockObservedAt) ? {
    cataloguePresent: true, catalogueObservedAt: observationTime(row.stockObservedAt),
  } : {};
}

// One atomic local update; stock quantities, observation timestamps, hidden
// state and editorial metadata are untouched. Absence is lifecycle evidence,
// not proof of zero stock, discontinuation or a replacement article.
export async function recordRenogyCatalogueMembership(db, rows, observedAt) {
  const catalogue = validCatalogueRows(rows, observedAt);
  const result = await db.query(`UPDATE products SET details = COALESCE(details, '{}'::jsonb)
    || jsonb_build_object('cataloguePresent', UPPER(TRIM(sku)) = ANY($1::text[]), 'catalogueObservedAt', $2::text)
    WHERE supplier = 'renogy' RETURNING details->'cataloguePresent' AS present`, [catalogue.skus, catalogue.observedAt]);
  return {
    listed: catalogue.skus.length,
    absent: result.rows.filter(row => row.present === false).length,
  };
}
