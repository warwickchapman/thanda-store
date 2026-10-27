import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const user = { id: 7, email: 'buyer@example.test', organisationName: 'Example company', role: 'buyer', apiEnabled: true };
function load(file, dependencies, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, ...globals, require: name => {
    if (name === 'react/jsx-runtime') return jsx;
    assert(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports;
}

function provider(responses, initialPath = '/') {
  let pathname = initialPath;
  let cursor = 0;
  let lastDependencies;
  let effect;
  let cleanup;
  let timer;
  const state = [];
  const calls = [];
  const component = load('../src/components/store-session.tsx', {
    'next/navigation': { usePathname: () => pathname },
    react: {
      createContext: () => ({ Provider: 'fixture-provider' }), useContext: () => null,
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
      },
      useEffect(callback, dependencies) {
        if (!lastDependencies || dependencies.some((value, index) => value !== lastDependencies[index])) {
          lastDependencies = dependencies;
          effect = callback;
        }
      },
    },
  }, {
    AbortController,
    setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {},
    fetch: async (path, options) => {
      calls.push({ path, options });
      const response = responses.shift();
      if (typeof response === 'function') return response(options.signal);
      if (response instanceof Error) throw response;
      return response;
    },
  });
  function render() {
    cursor = 0;
    let element = component.StoreSessionProvider({ children: 'fixture' });
    if (typeof element.type === 'function') element = element.type(element.props);
    return element.props.value;
  }
  return {
    calls, render,
    path(value) { pathname = value; },
    timeout() { timer(); },
    unmount() { cleanup?.(); },
    async settle() {
      render();
      if (effect) { cleanup?.(); cleanup = effect(); effect = null; }
      await new Promise(setImmediate);
      return render();
    },
  };
}

test('signed-in components share one no-store local session read across portal navigation', async () => {
  const session = provider([Response.json({ user })]);
  assert.equal(session.render().status, 'loading');
  const value = await session.settle();
  assert.equal(value.status, 'signed-in');
  assert.equal(value.user.email, user.email);
  session.path('/accounts');
  await session.settle();
  session.path('/admin/users');
  await session.settle();
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].path, '/api/session');
  assert.equal(session.calls[0].options.cache, 'no-store');
});

for (const path of ['/login', '/forgot-password', '/set-password', '/request-quote']) {
  test(`${path} neither loads nor exposes a signed-in identity`, async () => {
    const session = provider([], path);
    assert.equal((await session.settle()).user, null);
    assert.equal(session.calls.length, 0);
  });
}

test('401 is signed out, while failed or malformed reads are unknown and can be retried', async () => {
  for (const response of [new Response(null, { status: 503 }), Response.json({ user: {} }), new Error('Network failed')]) {
    const session = provider([response, Response.json({ user }), new Response(null, { status: 401 })]);
    let value = await session.settle();
    assert.equal(value.status, 'error');
    assert.equal(value.user, null);
    value.reload();
    assert.equal(session.render().status, 'loading');
    value = await session.settle();
    assert.equal(value.user.email, user.email);
    value.reload();
    assert.equal(session.render().user, null, 'Old identity clears before rechecking');
    value = await session.settle();
    assert.equal(value.status, 'signed-out');
    assert.equal(value.user, null);
    assert.equal(session.calls.length, 3, 'Only explicit retries make additional local requests');
  }
});

test('session timeout becomes an error and unmounted late responses cannot publish an identity', async () => {
  const timed = provider([signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted'))))]);
  await timed.settle();
  timed.timeout();
  assert.equal((await timed.settle()).status, 'error');
  let resolve;
  const late = provider([() => new Promise(done => { resolve = done; })]);
  await late.settle();
  late.unmount();
  resolve(Response.json({ user }));
  assert.equal((await late.settle()).user, null);
});

function header(session, path = '/') {
  const { StoreHeader } = load('../src/components/store-search.tsx', {
    'next/link': props => jsx.jsx('a', props),
    'next/navigation': { usePathname: () => path, useRouter: () => ({ push() {} }) },
    'lucide-react': { Search: () => null, UserRound: () => null, RefreshCw: () => null },
    '@/components/store-session': { useStoreSession: () => session },
    react: { createContext: () => ({}), useContext: () => ({ query: '', setQuery() {} }), useEffect() {}, useState: initial => [initial, () => {}] },
  });
  return renderToStaticMarkup(jsx.jsx(StoreHeader, {}));
}

test('shared header shows exact login email and company for admins and buyers', () => {
  for (const role of ['admin', 'buyer']) {
    for (const path of ['/', '/accounts', '/admin/users']) {
      const html = header({ status: 'signed-in', user: { ...user, role } }, path);
      assert(html.includes(user.email));
      assert(html.includes(user.organisationName));
      assert(html.includes('aria-label="Signed-in account"'));
      assert(html.includes('break-all'), 'Addresses must wrap on narrow screens');
    }
  }
});

test('impersonated header shows the customer, while the banner identifies the acting admin', () => {
  const customer = { ...user, impersonatedBy: { email: 'admin@example.test' } };
  const session = { status: 'signed-in', user: customer };
  assert(header(session).includes('aria-label="Customer being viewed"'));
  assert(!header(session).includes(customer.impersonatedBy.email));
  const { ImpersonationBanner } = load('../src/components/impersonation-banner.tsx', {
    '@/components/store-session': { useStoreSession: () => session },
    react: { useState: initial => [initial, () => {}] },
  });
  const html = renderToStaticMarkup(jsx.jsx(ImpersonationBanner, {}));
  assert(html.includes(`Viewing as ${user.email}`));
  assert(html.includes(`Acting admin: ${customer.impersonatedBy.email}`));
});

test('header distinguishes pending, unavailable and expired session details without inventing a user', () => {
  assert(header({ status: 'loading', user: null }).includes('Checking sign-in...'));
  const failed = header({ status: 'error', user: null, reload() {} });
  assert(failed.includes('Sign-in details unavailable'));
  assert(failed.includes('Retry sign-in details'));
  assert(!failed.includes(user.email));
  assert(header({ status: 'signed-out', user: null }).includes('Sign in'));
  assert.equal(header({ status: 'signed-in', user }, '/login'), '');
  const enquiry = header({ status: 'signed-in', user }, '/request-quote');
  assert(enquiry.includes('Trade sign in'));
  assert(!enquiry.includes(user.email));
});
