import pool from '@/lib/db';
import { currentCatalogue } from '@/lib/catalogue';
import { isStorefrontProduct } from '@/lib/catalogue-classification.mjs';
import { catalogueCsv, paginateCatalogue } from './catalogue-export.mjs';

export async function catalogueExport(request: Request, contactId: string) {
  // One pricing source for the browser, cart, quotes and API. All reads local.
  const rates = await pool.query('SELECT supplier,discount_percent,updated_at FROM contact_supplier_discounts WHERE contact_id=$1 ORDER BY supplier', [contactId]);
  const discounts = Object.fromEntries(rates.rows.map(r => [r.supplier, Number(r.discount_percent)]));
  const products = (await currentCatalogue(discounts)).filter(isStorefrontProduct);
  const meta = await pool.query(`SELECT p.id,p.last_updated,p.details->>'supplierObservedAt' AS supplier_updated_at,
    p.details->>'xeroStockSyncedAt' AS stock_updated_at,p.details->>'currency' AS currency,
    s.successor_sku FROM products p LEFT JOIN victron_sku_successions s ON p.supplier='victron' AND UPPER(p.sku)=UPPER(s.predecessor_sku)`);
  const byId = new Map(meta.rows.map(r => [Number(r.id),r]));
  const pricingDates = new Map(rates.rows.map(r => [r.supplier,r.updated_at]));
  const data = products.map(p => {
    const m = byId.get(Number(p.id));
    return { supplier:p.supplier,sku:p.sku,description:p.name,price_ex_vat:p.your_price_ex_vat,
      currency:m.currency || 'ZAR',thanda_stock:p.details.localStockOnHand,
      supplier_stock:p.supplier === 'lora' || p.stock_on_hand === null ? null : Number(p.stock_on_hand), successor_sku:m.successor_sku || null,
      updated_at:m.last_updated, supplier_updated_at:m.supplier_updated_at || null,thanda_stock_updated_at:m.stock_updated_at || null,
      pricing_updated_at:pricingDates.get(p.supplier) || null };
  }).sort((a,b) => a.supplier.localeCompare(b.supplier) || a.sku.localeCompare(b.sku));
  try {
    const url = new URL(request.url);
    const page = paginateCatalogue(data, contactId, url);
    const headers: Record<string,string> = { 'Cache-Control':'private, no-cache', Vary:'Authorization, Cookie', 'X-Catalogue-Revision':page.revision };
    if (page.changed) return Response.json({ error:'Catalogue changed during pagination. Restart from the first page.' }, { status:409,headers });
    headers.ETag = page.etag!;
    if (request.headers.get('if-none-match') === page.etag) return new Response(null,{status:304,headers});
    if (url.searchParams.get('format') === 'csv') return new Response(catalogueCsv(page.data!),{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="thanda-catalogue.csv"'}});
    return Response.json({ revision:page.revision,total:page.total,data:page.data,next_cursor:page.next_cursor },{headers});
  } catch(error) { return Response.json({error:error instanceof Error ? error.message : 'Invalid request.'},{status:400}); }
}
