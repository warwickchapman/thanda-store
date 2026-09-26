import { deriveCatalogueAttributes, filterDefinitions } from './catalogue-filters.mjs';
const manufacturerHosts = {
  victron: ['www.victronenergy.com','victronenergy.com'],
  renogy: ['www.renogy.com','renogy.com','uk.renogy.com','au.renogy.com'],
  hubble: ['www.hubbleenergy.com','hubbleenergy.com','www.hubblelithium.co.za','hubblelithium.co.za'],
};
export function publicManufacturerUrl(value, supplier) {
  try {
    const url=new URL(value);
    if (url.protocol!=='https:' || url.username || url.password || url.port || !(manufacturerHosts[supplier]||[]).includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
function plainText(value) {
  return typeof value==='string' ? value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').trim() : '';
}
export function productDetails(product) {
  const details=product.details||{};
  const derived=deriveCatalogueAttributes(product);
  const specifications=filterDefinitions.flatMap(f=>derived.attributes[f.key]?.length?[{label:f.label,value:derived.attributes[f.key].join(', ')}]:[]);
  const technical=Array.isArray(details.technicalData)?details.technicalData:Object.entries(details.technicalData||{}).map(([name,value])=>({name,value}));
  for (const spec of technical) {
    const label=plainText(spec?.name||spec?.label||spec?.field_name).replace(/([a-z])([A-Z])/g,'$1 $2');
    const raw=spec?.value??spec?.field_value;
    const value=typeof raw==='number'?String(raw):plainText(raw);
    if(label&&value&&!specifications.some(s=>s.label.toLowerCase()===label.toLowerCase())) specifications.push({label:label[0].toUpperCase()+label.slice(1),value});
  }
  const links=[];
  for(const doc of [...(Array.isArray(details.publicResources)?details.publicResources:[]),...(Array.isArray(details.documents)?details.documents:[])]) {
    const type=String(doc.kind||doc.document_type||'').toLowerCase();
    const kind=type==='product'?'product':type==='datasheet'?'datasheet':['manual','product manual'].includes(type)?'manual':null;
    const url=publicManufacturerUrl(doc.url,product.supplier);
    if(kind&&url&&!links.some(l=>l.url===url)) links.push({kind,title:plainText(doc.title||doc.name)||({product:'Manufacturer product page',datasheet:'Datasheet',manual:'Manual'})[kind],url});
  }
  return { description:plainText(details.description)||String(product.name),specifications:specifications.slice(0,80),links:links.slice(0,30) };
}
