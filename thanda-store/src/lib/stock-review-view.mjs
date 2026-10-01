export function stockReviewView(item) {
  if (item.creationPending) return 'awaiting';
  if (item.xeroStatus === 'missing' && !item.active) return 'needs';
  return 'reviewed';
}
