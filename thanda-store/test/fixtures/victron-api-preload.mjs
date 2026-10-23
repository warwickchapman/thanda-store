// The actual-job test may only contact its loopback fake E-Order service.
// Any unexpected fetch fails closed before network traffic is attempted.
const target = new URL(process.env.VICTRON_TEST_API_URL || '');
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
  || target.pathname !== '/' || target.username || target.password || target.search || target.hash) {
  throw new Error('A loopback VICTRON_TEST_API_URL is required');
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const requested = new URL(input instanceof Request ? input.url : String(input));
  if (requested.origin !== 'https://victron.test') throw new Error('Integration test refused non-fixture fetch');
  const local = new URL(requested.pathname + requested.search, target);
  return nativeFetch(local, { ...init, redirect: 'error' });
};
