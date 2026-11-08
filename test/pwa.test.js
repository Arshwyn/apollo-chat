import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import sharp from 'sharp';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('manifest is installable: standalone, scope, start url and the three icon entries', () => {
  const m = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.deepEqual(sizes, ['192x192:any', '512x512:any', '512x512:maskable']);
});

test('icons exist with the declared sizes', async () => {
  const m = JSON.parse(read('public/manifest.webmanifest'));
  for (const icon of m.icons) {
    const meta = await sharp(new URL(`../public${icon.src}`, import.meta.url).pathname).metadata();
    assert.equal(`${meta.width}x${meta.height}`, icon.sizes);
    assert.equal(meta.format, 'png');
  }
  assert.equal(
    (await sharp(new URL('../public/icons/apple-touch-icon.png', import.meta.url).pathname).metadata()).width,
    180,
  );
});

test('index links the manifest with credentials, theme colour and touch icon; registers the worker', () => {
  const html = read('public/index.html');
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest" crossorigin="use-credentials"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /name="viewport"/);
  assert.match(read('public/js/app.js'), /serviceWorker.register\('\/sw.js'\)/);
});

function loadWorker() {
  const listeners = {};
  const store = new Map();
  const puts = [];
  const caches = {
    open: async () => ({ put: async (k, v) => (puts.push(k), store.set(k, v)), addAll: async () => {} }),
    match: async (k) => store.get(k),
    keys: async () => [],
    delete: async () => true,
  };
  const ctx = {
    self: {
      location: { origin: 'https://app.example.com' },
      addEventListener: (n, f) => (listeners[n] = f),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches,
    URL,
    Request,
    Response,
    fetch: async () => {
      const r = new Response('ok');
      return r;
    },
  };
  vm.runInNewContext(read('public/sw.js'), ctx);
  const fire = (url, { method = 'GET', mode = 'cors' } = {}) => {
    let responded = null;
    listeners.fetch({
      request: { url: `https://app.example.com${url}`, method, mode },
      respondWith: (p) => (responded = p),
    });
    return responded;
  };
  return { fire, puts };
}

test('service worker never touches /api/ and only handles shell GETs', async () => {
  const { fire, puts } = loadWorker();
  assert.equal(fire('/api/conversations'), null);
  assert.equal(fire('/api/photos', { method: 'POST' }), null);
  assert.equal(fire('/api/conversations/x/messages'), null);
  assert.equal(fire('/something-else.js'), null);
  assert.ok(fire('/style.css'));
  assert.ok(fire('/', { mode: 'navigate' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    puts.every((k) => !k.startsWith('/api')),
    'nothing under /api is cached',
  );
});

test('service worker source has no cache rule for the API', () => {
  const src = read('public/sw.js');
  assert.match(src, /startsWith\('\/api\/'\)\) return/);
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(src)[1];
  const entries = [...shell.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(entries.length > 5);
  assert.equal(
    entries.some((e) => e.startsWith('/api/')),
    false,
  );
});

test('every @font-face url in style.css is precached by the worker and exists on disk', () => {
  const css = read('public/style.css');
  const urls = [...css.matchAll(/@font-face[^}]*?url\(["']?([^)"']+)["']?\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 3, 'Literata roman and italic plus Public Sans');
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(read('public/sw.js'))[1];
  const entries = [...shell.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const u of urls) {
    assert.ok(u.startsWith('/fonts/'), `${u} is same-origin`);
    assert.ok(entries.includes(u), `${u} is in SHELL`);
    assert.ok(fs.existsSync(new URL(`../public${u}`, import.meta.url)), `${u} exists`);
  }
  assert.match(read('public/sw.js'), /apollo-shell-v3/);
});

test('every script module under public/js is in the precached app shell', () => {
  const shell = /const SHELL = \[([\s\S]*?)\];/.exec(read('public/sw.js'))[1];
  const entries = [...shell.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const f of fs.readdirSync(new URL('../public/js/', import.meta.url)))
    assert.ok(entries.includes(`/js/${f}`), `/js/${f} is in SHELL`);
});
