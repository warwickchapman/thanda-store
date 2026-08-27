export type ProvisionalCartLine = { sku: string; quantity: number };
export type VictronEOrderUpload = { source: 'cart' | 'backorders'; lines: ProvisionalCartLine[] };
export type VictronBackorder = { orderNumber: string; lines: Array<ProvisionalCartLine & { description: string }> };

function cartLines(html: string): ProvisionalCartLine[] {
  const quantities = new Map<string, number>();
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const id = tag.match(/\bid=["']quantity-([A-Z0-9-]+)["']/i)?.[1]?.toUpperCase();
    const quantity = Number(tag.match(/\bvalue=["'](\d+)["']/i)?.[1]);
    if (!id || !Number.isInteger(quantity) || quantity < 1) continue;
    const previous = quantities.get(id);
    // The saved E-Order basket repeats each line for desktop and mobile views.
    if (previous !== undefined && previous !== quantity) throw new Error(`The saved cart has conflicting quantities for ${id}.`);
    quantities.set(id, quantity);
  }
  return [...quantities.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}

function backorderLines(html: string): ProvisionalCartLine[] {
  const quantities = new Map<string, number>();
  const lines = html.matchAll(/label-article-code">Article code:<\/label>\s*([A-Z0-9-]+)[\s\S]{0,1500}?<label>Remaining:<\/label>\s*(\d+)/gi);
  for (const match of lines) {
    const sku = match[1].toUpperCase();
    const quantity = Number(match[2]);
    if (!Number.isInteger(quantity) || quantity < 1) continue;
    quantities.set(sku, (quantities.get(sku) || 0) + quantity);
  }
  return [...quantities.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}

export function parseVictronEOrderHtml(html: string): VictronEOrderUpload {
  const cart = cartLines(html);
  if (cart.length) {
    if (cart.length > 500) throw new Error('The E-Order cart contains too many lines.');
    return { source: 'cart', lines: cart };
  }
  const backorders = backorderLines(html);
  if (backorders.length) {
    if (backorders.length > 500) throw new Error('The E-Order backorders report contains too many lines.');
    return { source: 'backorders', lines: backorders };
  }
  throw new Error('This does not look like a saved Victron E-Order basket or backorders page. Save either page and upload its HTML file.');
}

export function parseVictronBackordersHtml(html: string): VictronBackorder[] {
  const headings = [...html.matchAll(/Order Nr:<\/label>\s*(\d+)/gi)];
  const orders = headings.flatMap((heading, index) => {
    const section = html.slice(heading.index, headings[index + 1]?.index);
    const lines = [...section.matchAll(/grouped-item-part[\s\S]*?<div class="cell">\s*([^<]+?)\s*<\/div>[\s\S]*?label-article-code">Article code:<\/label>\s*([A-Z0-9-]+)[\s\S]{0,1500}?<label>Remaining:<\/label>\s*(\d+)/gi)].map((line) => ({ description: line[1].replace(/\s+/g, ' ').trim(), sku: line[2].toUpperCase(), quantity: Number(line[3]) })).filter((line) => line.description && Number.isInteger(line.quantity) && line.quantity > 0);
    return lines.length ? [{ orderNumber: heading[1], lines }] : [];
  });
  if (!orders.length) throw new Error('This does not look like a saved Victron E-Order Backorders page.');
  if (orders.length > 50 || orders.some((order) => order.lines.length > 500)) throw new Error('The E-Order backorders report contains too many lines.');
  return orders;
}

export function parseVictronBasketHtml(html: string): ProvisionalCartLine[] {
  const cart = cartLines(html);
  if (!cart.length) throw new Error('This does not look like a saved Victron E-Order cart. Save the basket overview page and upload its HTML file.');
  if (cart.length > 500) throw new Error('The provisional cart contains too many lines.');
  return cart;
}
