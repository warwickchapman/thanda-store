#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';

const inputPdf = process.argv[2];
const outputFile = process.argv[3] || path.resolve('data/victron-zar-2026-q3-skus.json');

if (!inputPdf) {
  console.error('Usage: node scripts/extract-victron-allowlist.mjs /path/to/Victron-price-list.pdf [output-json]');
  process.exit(1);
}

const python = process.env.PYTHON || 'python3';
const script = String.raw`
import json
import re
import sys
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    print("pdfplumber is required. Install it or run with the Codex workspace Python runtime.", file=sys.stderr)
    raise

input_pdf = Path(sys.argv[1])
output_file = Path(sys.argv[2])
sku_re = re.compile(r'\b[A-Z]{2,5}\d[A-Z0-9]{5,}R?\b')
exclude = {'RAS001260LAS'}
skus = set()

with pdfplumber.open(input_pdf) as pdf:
    for page in pdf.pages:
        text = page.extract_text() or ''
        for line in text.splitlines():
            if 'ZAR' not in line:
                continue
            for sku in sku_re.findall(line):
                if sku not in exclude:
                    skus.add(sku)

data = {
    'sourceName': input_pdf.name,
    'market': 'ZA',
    'currency': 'ZAR',
    'priceBasis': 'recommended_end_user_ex_vat',
    'generatedFrom': 'PDF text extraction; rows containing ZAR price lines',
    'skuCount': len(skus),
    'skus': sorted(skus),
}

output_file.parent.mkdir(parents=True, exist_ok=True)
output_file.write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps({'output': str(output_file), 'skuCount': len(skus)}, indent=2))
`;

const result = spawnSync(python, ['-c', script, inputPdf, outputFile], {
  stdio: 'inherit',
});

process.exit(result.status || 0);
