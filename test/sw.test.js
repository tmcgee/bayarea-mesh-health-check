// Service worker cache recovery, adapted from upstream 9efe04a0. The worker runs
// in a vm context with an in-memory cache, so no browser is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function worker({ response, failStorage = false, failRead = false, failOpen = false } = {}) {
  const handlers = {};
  const entries = new Map();
  const key = (request) => (typeof request === 'string' ? request : new URL(request.url).pathname);
  const cache = {
    match: async (request) => {
      if (failRead) throw new Error('storage unavailable');
      return entries.get(key(request))?.clone();
    },
    put: async (request, value) => {
      if (failStorage) throw new Error('quota exceeded');
      entries.set(key(request), value.clone());
    },
  };
  const context = vm.createContext({
    Request, Response, URL,
    self: { location: { origin: 'https://example.test' }, addEventListener: (event, fn) => { handlers[event] = fn; } },
    caches: {
      match: cache.match,
      open: async () => {
        if (failOpen) throw new Error('storage unavailable');
        return cache;
      },
    },
    fetch: async () => {
      if (response instanceof Error) throw response;
      return response.clone();
    },
  });
  vm.runInContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  return {
    entries,
    handlers,
    request: (path, mode) => {
      const request = new Request(`https://example.test${path}`);
      if (mode) Object.defineProperty(request, 'mode', { value: mode });
      let result;
      handlers.fetch({ request, respondWith: (promise) => { result = promise; } });
      return result;
    },
    cacheFirst: (path) => context.cacheFirst(new Request(`https://example.test${path}`)),
  };
}

for (const status of [500, 502, 503, 504]) {
  test(`HTTP ${status} preserves and serves cached asset bytes`, async () => {
    const sw = worker({ response: new Response('temporary failure', { status }) });
    sw.entries.set('/app.js', new Response('good javascript'));
    const response = await sw.request('/app.js');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'good javascript');
    assert.equal(await sw.entries.get('/app.js').text(), 'good javascript');
  });
}

for (const status of [401, 403, 404]) {
  test(`HTTP ${status} is not masked or cached`, async () => {
    const sw = worker({ response: new Response('denied or missing', { status }) });
    sw.entries.set('/app.js', new Response('good javascript'));
    assert.equal((await sw.request('/app.js')).status, status);
    assert.equal(await sw.entries.get('/app.js').text(), 'good javascript');
  });
}

for (const path of ['/missing.js', '/missing.css']) {
  test(`offline ${path} never receives dashboard HTML`, async () => {
    const sw = worker({ response: new Error('offline') });
    sw.entries.set('/app', new Response('<html>dashboard</html>'));
    await assert.rejects(sw.request(path), /offline/);
  });
}

test('offline navigation keeps the dashboard fallback and cached assets keep their bytes', async () => {
  const sw = worker({ response: new Error('offline') });
  sw.entries.set('/app', new Response('<html>dashboard</html>'));
  sw.entries.set('/app.js', new Response('good javascript'));
  assert.equal(await (await sw.request('/app.js')).text(), 'good javascript');
  assert.equal(await (await sw.request('/somewhere', 'navigate')).text(), '<html>dashboard</html>');
});

for (const failure of ['failStorage', 'failOpen', 'failRead']) {
  test(`successful network responses survive ${failure}`, async () => {
    const sw = worker({ response: new Response('fresh javascript'), [failure]: true });
    assert.equal(await (await sw.request('/app.js')).text(), 'fresh javascript');
    assert.equal(await (await sw.cacheFirst('/another.js')).text(), 'fresh javascript');
  });
}

for (const status of [500, 503, 404]) {
  test(`uncached HTTP ${status} returns its actual error, not dashboard HTML`, async () => {
    const sw = worker({ response: new Response('network error', { status }) });
    sw.entries.set('/app', new Response('<html>dashboard</html>'));
    const result = await sw.request('/missing.js');
    assert.equal(result.status, status);
    assert.equal(await result.text(), 'network error');
    assert.equal(sw.entries.has('/missing.js'), false);
  });
}

for (const path of ['/api/bootstrap', '/api/reseed-status', '/share/result']) {
  test(`${path} bypasses cached content even on a transient failure`, async () => {
    const sw = worker({ response: new Response('unavailable', { status: 503 }) });
    sw.entries.set(path, new Response('stale private response'));
    assert.equal((await sw.request(path)).status, 503);
  });
}

test('a successful network fetch refreshes cached asset bytes', async () => {
  const sw = worker({ response: new Response('fresh javascript') });
  sw.entries.set('/app.js', new Response('old javascript'));
  assert.equal(await (await sw.request('/app.js')).text(), 'fresh javascript');
  assert.equal(await sw.entries.get('/app.js').text(), 'fresh javascript');
});

test('cacheFirst does not store HTTP errors', async () => {
  const sw = worker({ response: new Response('missing', { status: 404 }) });
  assert.equal((await sw.cacheFirst('/missing.js')).status, 404);
  assert.equal(sw.entries.size, 0);
});

for (const response of [
  new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
  Object.defineProperty(new Response('redirected'), 'redirected', { value: true }),
]) {
  test(`asset responses with ${response.redirected ? 'redirects' : 'HTML'} do not overwrite good assets`, async () => {
    response.clone = () => response;
    const sw = worker({ response });
    sw.entries.set('/app.js', new Response('good javascript'));
    await sw.request('/app.js');
    assert.equal(await sw.entries.get('/app.js').text(), 'good javascript');
  });
}

test('the cache revision moved so installed apps pick up the new worker', () => {
  const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(source, /const CACHE_NAME = 'mesh-health-check-pwa-v8-bayarea';/);
});
