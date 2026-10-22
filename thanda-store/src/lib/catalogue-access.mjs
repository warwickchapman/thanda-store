function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Account identities stay in server configuration. An unset or empty list
// hides the supplier from everyone, including administrators and API keys.
export function enertecPreviewEmails() {
  return [...new Set(String(process.env.ENERTEC_PREVIEW_EMAILS || '').split(',')
    .map(normalizedEmail).filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

export function isCatalogueRestricted(product) {
  return String(product?.supplier || '').trim().toLowerCase() === 'enertec'
    || Object.hasOwn(product?.details || {}, 'catalogueVisibility');
}

export function isProductVisibleTo(product, userEmail) {
  const email = normalizedEmail(userEmail);
  if (String(product?.supplier || '').trim().toLowerCase() === 'enertec'
    && !enertecPreviewEmails().includes(email)) return false;
  if (!Object.hasOwn(product?.details || {}, 'catalogueVisibility')) return true;
  // Malformed or empty restrictions fail closed. A row-level restriction can
  // narrow a supplier preview, but cannot broaden its account allowlist.
  const allowed = product.details.catalogueVisibility?.allowedEmails;
  return Boolean(email) && Array.isArray(allowed)
    && allowed.some(value => normalizedEmail(value) === email);
}
