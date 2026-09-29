// Deliberately exclude check times, retry countdowns and quantities: a routine
// refresh is not a new incident. Changes in affected items/reasons are meaningful.
export function planningHealthSignature(health, items) {
  return JSON.stringify({
    sources: health.sourceIssues.map(source => [source.id, source.status]).sort(),
    warnings: [...health.warnings].sort(),
    items: items.filter(item => item.suggestedOrder === null || item.itemReviewReasons?.length)
      .map(item => [item.sku, item.suggestedOrder === null, [...(item.itemReviewReasons || [])].sort()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  });
}
