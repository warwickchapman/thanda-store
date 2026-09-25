#!/usr/bin/env node
// Review a bounded local metadata snapshot, with no database or network writes.
import fs from 'node:fs';
import { deriveCatalogueAttributes } from '../src/lib/catalogue-filters.mjs';
import { isStorefrontProduct } from '../src/lib/catalogue-classification.mjs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/review-catalogue-classification.mjs <snapshot.json> <report.md>');
const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
const reviewed = rows.filter(p => !p.details?.hidden && isStorefrontProduct(p)).map(p => ({ before: p, after: deriveCatalogueAttributes(p) }));
const moves = reviewed.filter(p => p.before.category !== p.after.classification.category);
const uncertain = reviewed.filter(p => p.after.classification.reviewReason);
const measured = reviewed.filter(p => Object.keys(p.after.measurements).length);
const counts = new Map();
for (const p of moves) {
  const key = `${p.before.category} → ${p.after.classification.category}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}
const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, rows) => [head.join(' | '), head.map(() => '---').join(' | '), ...rows.map(r => r.map(cell).join(' | '))].join('\n');
const report = `# Catalogue classification review\n\nGenerated from a cached metadata snapshot on ${new Date().toISOString().slice(0, 10)}. No external API calls. Supplier categories, stock, prices, hidden flags and SKU successions remain unchanged. Existing Renogy storefront scope is retained.\n\n${reviewed.length} storefront products reviewed; ${moves.length} category changes; ${measured.length} products with numeric cable measurements; ${uncertain.length} products retained for review.\n\n## Category changes\n\n${table(['Change', 'Products'], [...counts])}\n\n## All reclassified products\n\n${table(['SKU', 'Name', 'Supplier category / subcategory', 'Display category', 'Product type'], moves.map(p => [p.before.sku, p.before.name, `${p.before.category} / ${p.before.details?.subcategory || '-'}`, p.after.classification.category, p.after.classification.typeLabel]))}\n\n## Numeric cable measurements\n\n${table(['SKU', 'Name', 'Old length', 'Cable length (m)', 'Conductor size (mm²)', 'Family'], measured.map(p => [p.before.sku, p.before.name, p.before.details?.catalogueAttributes?.length?.join(', '), p.after.measurements.cableLengthM, p.after.measurements.conductorSizeMm2, p.after.attributes.cableType?.join(', ')]))}\n\n## Uncertain products retained\n\nThese retain their supplier category and receive no guessed specifications. A reviewed per-product override can resolve them later.\n\n${table(['SKU', 'Name', 'Category / subcategory', 'Reason'], uncertain.map(p => [p.before.sku, p.before.name, `${p.before.category} / ${p.before.details?.subcategory || '-'}`, p.after.classification.reviewReason]))}\n`;
fs.writeFileSync(output, report);
console.log(JSON.stringify({ reviewed: reviewed.length, categoryChanges: moves.length, measuredCables: measured.length, uncertain: uncertain.length, moves: Object.fromEntries(counts), report: output }));
