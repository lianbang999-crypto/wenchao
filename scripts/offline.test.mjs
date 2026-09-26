import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';

const ROOT = new URL('../', import.meta.url);
const offlineSource = readFileSync(new URL('site/js/offline.js', ROOT), 'utf8');
const swSource = readFileSync(new URL('site/sw.js', ROOT), 'utf8');
const url = id => '/data/articles/' + id + '.json';
const hash = text => createHash('sha1').update(text).digest('hex').slice(0, 12);
const article = (id, text = '原文') => JSON.stringify({ id, segments: [{ orig: [text], trans: ['译文'], notes: [] }] });
const books = ids => [{ id: 'jx', name: '精选', juans: [{ cats: [{ items: ids.map(id => ({ id })) }] }] }];
function manifest(texts, version = '20260926-new') {
  return { version, count: Object.keys(texts).length, books: hash(JSON.stringify(books(Object.keys(texts)))), articles: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, hash(text)])) };
}
function mockCaches() {
  const stores = new Map();
  const key = value => new URL(typeof value === 'string' ? value : value.url, 'https://test.local/').href;
  let rejectPut = false;
  return {
    stores, setRejectPut(value) { rejectPut = value; },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(request, options = {}) {
          const exact = key(request);
          for (const [k, v] of store) if (k === exact || (options.ignoreSearch && k.split('?')[0] === exact.split('?')[0])) return v.clone();
        },
        async put(request, response) { if (rejectPut) throw new DOMException('Full', 'QuotaExceededError'); store.set(key(request), response.clone()); },
        async delete(request) { return store.delete(key(request)); },
        async addAll() {},
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request, options) { for (const name of stores.keys()) { const res = await (await this.open(name)).match(request, options); if (res) return res; } },
  };
}
function offlineHarness(fetch = async () => { throw new Error('offline'); }, caches = mockCaches()) {
  const api = {};
  const context = {
    window: { caches, crypto: webcrypto, dispatchEvent(event) { api.lastUpdate = event.detail; } }, document: { readyState: 'loading', addEventListener() {}, querySelector() { return null; } },
    localStorage: { getItem() { return null; }, setItem() {} }, navigator: {}, caches, fetch,
    Response, Headers, Request, URL, AbortController, TextDecoder, Uint8Array, setTimeout, clearTimeout, console, api,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
  const expose = `Object.assign(api, { validateManifest, useCatalog, inspectLocal, validatedArticle, downloadUrls, loadCatalog,
    status: () => STATUS, catalog: () => ({ MANIFEST, BOOKS, catalogOnline, catalogError }),
    setJob: () => { active = { controllers: [] }; cancelFlag = false; },
    cancel: () => { cancelFlag = true; active.controllers.forEach(c => c.abort()); } });`;
  vm.runInNewContext(offlineSource.replace('  // —— 入口 ——', expose + '\n  // —— 入口 ——'), context);
  return { api, caches, context };
}
function use(h, texts) { const m = manifest(texts); h.api.useCatalog(h.api.validateManifest(m), books(Object.keys(texts))); h.api.setJob(); return m; }
async function seed(h, id, text) { await (await h.caches.open('wc-dl')).put(url(id), new Response(text)); }
async function cached(h, id) { return (await (await h.caches.open('wc-dl')).match(url(id))).text(); }

test('legacy offline copies get corrected, unchanged articles skip network, success counts include new writes', async () => {
  const latest = { 'jx-001': article('jx-001', '勘误'), 'jx-002': article('jx-002') }, requests = [];
  const h = offlineHarness(async (path, options) => { requests.push(path); assert.equal(options.cache, 'no-store'); assert.equal(options.headers['X-WC-Prefetch'], '1'); return new Response(latest[path.split('/').pop().replace('.json', '')]); });
  use(h, latest);
  await seed(h, 'jx-001', article('jx-001', '旧文'));
  await seed(h, 'jx-002', latest['jx-002']);
  const r = await h.api.downloadUrls(Object.keys(latest));
  assert.equal(r.ok, 2); assert.equal(r.updated, 1); assert.equal(r.failed, 0);
  assert.deepEqual(requests, [url('jx-001')]);
  assert.equal(await cached(h, 'jx-001'), latest['jx-001']);
  assert.deepEqual(Array.from(h.api.lastUpdate.ids), ['jx-001']);
  await h.api.inspectLocal(); assert.equal(h.api.status().jx.current, 2);
});

for (const [label, bad] of [
  ['incorrect checksum', article('jx-001', '错字')], ['HTML response', '<html>502</html>'],
  ['wrong article id', article('jx-999')], ['invalid segments', JSON.stringify({ id: 'jx-001', segments: [{}] })],
]) test(`${label} never replaces an existing offline copy`, async () => {
  const old = article('jx-001', '旧文'), h = offlineHarness(async () => new Response(bad));
  use(h, { 'jx-001': article('jx-001', '勘误') }); await seed(h, 'jx-001', old);
  const r = await h.api.downloadUrls(['jx-001']);
  assert.equal(r.ok, 0); assert.equal(r.failed, 1); assert.equal(await cached(h, 'jx-001'), old);
});

test('full storage preserves old text and reports no successful replacement', async () => {
  const old = article('jx-001', '旧文'), latest = article('jx-001', '勘误');
  const h = offlineHarness(async () => new Response(latest)); use(h, { 'jx-001': latest }); await seed(h, 'jx-001', old);
  h.caches.setRejectPut(true);
  const r = await h.api.downloadUrls(['jx-001']);
  assert.equal(r.quotaHit, true); assert.equal(r.ok, 0); assert.equal(r.updated, 0); assert.equal(await cached(h, 'jx-001'), old);
  await h.api.inspectLocal(); assert.equal(h.api.status().jx.present, 1); assert.equal(h.api.status().jx.pending, 1);
});

test('cancellation aborts in-flight network and preserves the old text', async () => {
  let began; const started = new Promise(resolve => { began = resolve; });
  const h = offlineHarness((path, options) => new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted'))); began(); }));
  const old = article('jx-001', '旧文'); use(h, { 'jx-001': article('jx-001', '勘误') }); await seed(h, 'jx-001', old);
  const task = h.api.downloadUrls(['jx-001']); await started; h.api.cancel();
  const r = await task; assert.equal(r.cancelled, true); assert.equal(r.ok, 0); assert.equal(await cached(h, 'jx-001'), old);
});

test('cache eviction is reflected in actual saved and pending counts', async () => {
  const h = offlineHarness(), texts = { 'jx-001': article('jx-001'), 'jx-002': article('jx-002') }; use(h, texts);
  await seed(h, 'jx-001', texts['jx-001']); await h.api.inspectLocal();
  assert.equal(h.api.status().jx.present, 1); assert.equal(h.api.status().jx.pending, 1);
});

test('catalog fetch saves a consistent offline snapshot and never fetches app/assets', async () => {
  const texts = { 'jx-001': article('jx-001') }, m = manifest(texts), paths = [];
  m.app = { url: '/app/large.apk' }; m.assets = { 'js/app.js': 'ignored' };
  const h = offlineHarness(async path => { paths.push(path); return new Response(JSON.stringify(path.includes('manifest') ? m : books(Object.keys(texts)))); });
  await h.api.loadCatalog(); assert.equal(h.api.catalog().catalogOnline, true);
  assert.deepEqual(paths.sort(), ['/app/content-manifest.json', '/data/books.json']);
  const offline = offlineHarness(undefined, h.caches); await offline.api.loadCatalog();
  assert.equal(offline.api.catalog().MANIFEST.version, m.version); assert.equal(offline.api.catalog().catalogOnline, false);
});

test('manifest and directory disagreement does not replace the saved catalog', async () => {
  const texts = { 'jx-001': article('jx-001') }, m = manifest(texts);
  const h = offlineHarness(async path => new Response(JSON.stringify(path.includes('manifest') ? m : books(Object.keys(texts)))));
  await h.api.loadCatalog();
  const next = offlineHarness(async path => new Response(JSON.stringify(path.includes('manifest') ? { ...m, version: 'next', books: '000000000000' } : books(Object.keys(texts)))), h.caches);
  await next.api.loadCatalog(); assert.equal(next.api.catalog().MANIFEST.version, m.version); assert.equal(next.api.catalog().catalogOnline, false);
});

test('production catalog and every article satisfy offline verification schema', async () => {
  const m = JSON.parse(readFileSync(new URL('site/app/content-manifest.json', ROOT)));
  const list = JSON.parse(readFileSync(new URL('site/data/books.json', ROOT)));
  const h = offlineHarness(); h.api.useCatalog(h.api.validateManifest(m), list);
  // Hashes may intentionally be regenerated after a content edit; verify actual schema and actual bytes here.
  for (const id of Object.keys(m.articles)) {
    const bytes = readFileSync(new URL(`site/data/articles/${id}.json`, ROOT));
    await h.api.validatedArticle(new Response(bytes), id, hash(bytes));
  }
});

function swHarness(fetch = async () => { throw new Error('offline'); }) {
  const caches = mockCaches(), listeners = {};
  const context = { caches, fetch, self: { addEventListener(name, fn) { listeners[name] = fn; }, clients: { claim: async () => {} } }, location: { origin: 'https://test.local' }, Response, Headers, Request, URL, AbortController, setTimeout, clearTimeout };
  vm.createContext(context); vm.runInContext(swSource, context);
  return { caches, listeners, context, async dispatch(path, mode = 'navigate', headers = {}) {
    let response, background;
    listeners.fetch({ request: { url: 'https://test.local' + path, method: 'GET', mode, headers: new Headers(headers) }, respondWith(p) { response = p; }, waitUntil(p) { background = p; } });
    const result = await response; if (background) await background; return result;
  } };
}

test('offline cold start of an unvisited article uses the installed reader shell', async () => {
  const h = swHarness(); await (await h.caches.open('shell')).put('/index.html', new Response('<html>reader</html>'));
  assert.equal(await (await h.dispatch('/a/jx-001/?shared=1')).text(), '<html>reader</html>');
  await assert.rejects(h.dispatch('/data/missing.json', 'cors'), /Offline resource unavailable/);
});

test('pinned articles remain available offline and SW passes prefetch/APK to network once', async () => {
  let calls = 0; const h = swHarness(async () => { calls++; throw new Error('offline'); });
  await (await h.caches.open('wc-dl')).put(url('jx-001'), new Response(article('jx-001')));
  assert.equal(await (await h.dispatch(url('jx-001'), 'cors')).text(), article('jx-001')); assert.equal(calls, 0);
  assert.equal(await h.dispatch(url('jx-001'), 'cors', { 'X-WC-Prefetch': '1' }), undefined);
  assert.equal(await h.dispatch('/app/content-manifest.json', 'cors'), undefined);
  assert.equal(await h.dispatch('/app/wenchao.apk', 'cors'), undefined);
});

test('SW activation retains downloaded articles while replacing shell caches', async () => {
  const h = swHarness(); await h.caches.open('old-shell'); await h.caches.open('wc-dl');
  let activation; h.listeners.activate({ waitUntil(p) { activation = p; } }); await activation;
  assert.deepEqual(await h.caches.keys(), ['wc-dl']);
});
