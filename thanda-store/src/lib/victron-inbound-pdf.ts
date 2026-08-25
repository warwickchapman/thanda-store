import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type VictronInboundLine = {
  sku: string;
  description: string;
  quantity: number;
  isStockItem: boolean;
};

export type VictronInboundDocument = {
  invoiceNumber: string;
  supplierOrderNumber: string;
  customerPurchaseOrder: string | null;
  lines: VictronInboundLine[];
};

type PositionedText = { text: string; x: number; y: number };

function groupedRows(items: PositionedText[]) {
  const rows = new Map<number, PositionedText[]>();
  for (const item of items) {
    if (!item.text.trim()) continue;
    // Some invoice text glyphs on the same visual baseline differ by a
    // fraction of a point; cluster them rather than dropping a line item.
    const y = Math.round(item.y / 2) * 2;
    rows.set(y, [...(rows.get(y) || []), item]);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, row]) => row.sort((a, b) => a.x - b.x));
}

function headerValue(label: string, items: PositionedText[]) {
  const heading = items.find((item) => item.text.trim().toLowerCase() === label.toLowerCase() && item.x > 200);
  if (!heading) return '';
  return items
    // Victron's invoice-detail values occupy the fixed centre column; keeping
    // this narrow avoids similarly aligned delivery-address text.
    .filter((item) => item.x >= 310 && item.x < 400 && Math.abs(item.y - heading.y) < 3 && item.text.trim())
    .sort((a, b) => a.x - b.x)
    .map((item) => item.text)
    .join('')
    .replace(/^:\s*/, '')
    .trim();
}

/** Extracts the stable article/quantity columns from a Victron tax invoice. */
export async function parseVictronInboundPdf(data: Uint8Array): Promise<VictronInboundDocument> {
  const pdf = await getDocument({ data }).promise;
  let headerItems: PositionedText[] = [];
  const lines: VictronInboundLine[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const positioned = content.items
      .filter((item): item is typeof item & { str: string; transform: number[] } => 'str' in item && 'transform' in item)
      .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5] }));
    if (pageNumber === 1) headerItems = positioned;

    for (const row of groupedRows(positioned)) {
      const number = row.filter((item) => item.x >= 25 && item.x < 55).map((item) => item.text).join('').trim();
      const quantity = row.filter((item) => item.x >= 75 && item.x < 90).map((item) => item.text).join('').trim();
      const sku = row.filter((item) => item.x >= 90 && item.x < 170).map((item) => item.text).join('').trim().toUpperCase();
      const description = row.filter((item) => item.x >= 175 && item.x < 430).map((item) => item.text).join('').replace(/\s+/g, ' ').trim();
      if (!/^\d+$/.test(number) || !/^\d+$/.test(quantity) || !/^[A-Z0-9-]{6,}$/.test(sku) || !description) continue;
      lines.push({ sku, description, quantity: Number(quantity), isStockItem: !sku.startsWith('SAL') });
    }
  }

  const invoiceNumber = headerValue('Invoice nr.', headerItems);
  const supplierOrderNumber = headerValue('Order nr.', headerItems);
  const customerPurchaseOrder = headerValue('Your order nr.', headerItems) || null;
  if (!invoiceNumber || !supplierOrderNumber || !lines.length) {
    throw new Error('This does not look like a supported Victron tax invoice. Check the extracted details and add the order manually.');
  }
  return { invoiceNumber, supplierOrderNumber, customerPurchaseOrder, lines };
}
