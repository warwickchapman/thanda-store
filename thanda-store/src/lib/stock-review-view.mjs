export function stockReviewView(item) {
  if (item.creationPending) return 'awaiting';
  if (item.xeroStatus === 'missing' && !item.active) return 'needs';
  return 'reviewed';
}

// Data health diagnoses a missing literal definition in Thanda. Do not redirect
// it to a successor or retail sibling: those are context, not the missing code.
export function catalogueReviewUrl(sku) {
  return `/admin/victron-catalogue?company=thanda-solar&sku=${encodeURIComponent(String(sku).trim().toUpperCase())}`;
}
