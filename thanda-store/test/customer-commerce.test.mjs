import assert from 'node:assert/strict';
import test from 'node:test';
import {newApiKey,tokenHash} from '../src/lib/commerce/api-keys.mjs';
import {paginateCatalogue,catalogueCsv} from '../src/lib/commerce/catalogue-export.mjs';
import {productDetails,publicManufacturerUrl} from '../src/lib/product-details.mjs';
import {quoteNotificationPayloads,validRequestId} from '../src/lib/commerce/quote-requests.mjs';
import {deliveryState} from '../src/lib/commerce/notifications.mjs';

test('keys contain 256 random bits, only a one-way hash is persisted',()=>{
 const a=newApiKey(),b=newApiKey();assert.match(a.token,/^ts_[\w-]{43}$/);assert.notEqual(a.token,b.token);assert.equal(a.hash,tokenHash(a.token));assert.notEqual(a.hash,a.token);assert.equal(a.prefix.length,11);
});
test('API cursors and ETags detect company price changes and enforce company isolation',()=>{
 const rows=[{sku:'a',price_ex_vat:100},{sku:'b',price_ex_vat:200}];const url=new URL('https://example.test/api/v1/products?limit=1');
 const first=paginateCatalogue(rows,'company-a',url);assert.deepEqual(first.data,[rows[0]]);assert.ok(first.next_cursor);
 url.searchParams.set('cursor',first.next_cursor);const second=paginateCatalogue(rows,'company-a',url);assert.deepEqual(second.data,[rows[1]]);assert.equal(second.next_cursor,null);
 assert.equal(paginateCatalogue(rows,'company-b',url).changed,true);
 assert.equal(paginateCatalogue([{...rows[0],price_ex_vat:90},rows[1]],'company-a',url).changed,true);
 assert.equal(paginateCatalogue(rows,'company-a',new URL('https://example.test?limit=1')).etag,first.etag);
 assert.throws(()=>paginateCatalogue(rows,'a',new URL('https://example.test?limit=251')));
 assert.throws(()=>paginateCatalogue(rows,'a',new URL('https://example.test?cursor=bad')));
});
test('CSV exports the same values and escapes formula injection, commas and quotes',()=>{
 const csv=catalogueCsv([{supplier:'victron',sku:'=unsafe',description:'Cable, "long"',price_ex_vat:123.45,currency:'ZAR',thanda_stock:null,supplier_stock:0}]);
 assert.ok(csv.includes('"\'=unsafe"'));assert.ok(csv.includes('"Cable, ""long"""'));assert.ok(csv.includes('"123.45","ZAR","","0"'));
});
test('product details use supplier specifications and only verified public manufacturer resources',()=>{
 const p={supplier:'victron',name:'Full product name',category:'Other',details:{description:'<p>Full description</p><script>bad()</script>',technicalData:[{field_name:'maximumChargeCurrent',field_value:'80 A'}],documents:[
 {document_type:'Product Manual',name:'Manual',url:'https://www.victronenergy.com/upload/documents/Manual.pdf'},
 {document_type:'Datasheet',name:'Private',url:'https://eorder.victronenergy.com/api/v1/products/A'},
 {document_type:'Video',url:'https://www.victronenergy.com/video.mp4'},
 {document_type:'Datasheet',url:'javascript:alert(1)'},
 ],publicResources:[{kind:'product',url:'https://www.victronenergy.com/inverters-chargers/multi-rs-solar',title:'Product'}]}};
 const d=productDetails(p);assert.equal(d.description,'Full description');assert.deepEqual(d.specifications,[{label:'Maximum Charge Current',value:'80 A'}]);assert.equal(d.links.length,2);
 for(const url of ['http://www.victronenergy.com/x','https://www.victronenergy.com.evil.test/x','https://user:pass@www.victronenergy.com/x','https://www.victronenergy.com:444/x'])assert.equal(publicManufacturerUrl(url,'victron'),null);
 assert.equal(productDetails({...p,details:{}}).description,p.name);
});
test('quote receipts preserve the request reference; provider acceptance is not delivery',()=>{
 const quote={QuoteID:'q',QuoteNumber:'Q-1',Reference:'Job 1',Status:'DRAFT',LineItems:[{Quantity:2,Description:'Panel',ItemCode:'SKU'}]};
 const notices=quoteNotificationPayloads(quote,{companyName:'Example',buyerEmail:'buyer@example.test',salesEmail:'sales@example.test',baseUrl:'https://store.example.test',source:'cart'});
 assert.match(notices.buyer.text,/2 x Panel \(SKU\)/);assert.match(notices.buyer.text,/accounts\?quote=q/);assert.match(notices.sales.text,/Job 1/);
 assert.equal(deliveryState('sent'),'accepted');assert.equal(deliveryState('delivered'),'delivered');assert.equal(deliveryState('bounced'),'failed');assert.equal(deliveryState(undefined),'accepted');
 assert.equal(validRequestId(newApiKey().id),true);assert.equal(validRequestId('invalid'),false);
});
