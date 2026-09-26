import crypto from 'node:crypto';
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function catalogueCsv(rows) {
  const columns = ['supplier','sku','description','price_ex_vat','currency','thanda_stock','supplier_stock','successor_sku','updated_at','supplier_updated_at','thanda_stock_updated_at','pricing_updated_at'];
  return [columns.join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
export function paginateCatalogue(rows, scope, url) {
  const revision = crypto.createHash('sha256').update(JSON.stringify({ scope, rows })).digest('hex');
  const limit = Number(url.searchParams.get('limit') || 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error('limit must be between 1 and 250.');
  let offset = 0;
  const encoded = url.searchParams.get('cursor');
  if (encoded) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw new Error('Invalid cursor.'); }
    if (cursor.revision !== revision) return { changed: true, revision };
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > rows.length) throw new Error('Invalid cursor.');
    offset = cursor.offset;
  }
  const csv = url.searchParams.get('format') === 'csv';
  const next = offset + limit;
  return { revision, changed: false, etag: `"${revision}:${csv ? 'csv' : `${offset}:${limit}`}"`,
    data: csv ? rows : rows.slice(offset, next), total: rows.length,
    next_cursor: !csv && next < rows.length ? Buffer.from(JSON.stringify({ revision, offset: next })).toString('base64url') : null };
}
