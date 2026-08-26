export type ProvisionalCartLine = { sku: string; quantity: number };

export function parseVictronBasketHtml(html: string): ProvisionalCartLine[] {
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
  if (!quantities.size) throw new Error('This does not look like a saved Victron E-Order cart. Save the basket overview page and upload its HTML file.');
  if (quantities.size > 500) throw new Error('The provisional cart contains too many lines.');
  return [...quantities.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}
