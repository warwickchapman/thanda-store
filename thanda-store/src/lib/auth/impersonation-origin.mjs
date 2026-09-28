const DEFAULT_PUBLIC_ORIGIN = 'https://store.thanda.solar';

export function validCustomerViewOrigin(request, { portalBaseUrl, nodeEnv } = {}) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const publicUrl = portalBaseUrl || (nodeEnv === 'production' ? DEFAULT_PUBLIC_ORIGIN : request.url);
  try {
    return new URL(origin).origin === origin && origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}
