// App-shell service worker. It caches the static shell only. Anything under /api/ (chats, photos) is
// never read from or written to a cache: health data must not sit in a shared browser cache.
const CACHE = 'apollo-shell-v3';
const SHELL = [
  '/',
  '/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/render.js',
  '/js/copy.js',
  '/js/drawer.js',
  '/js/format.js',
  '/js/sse.js',
  '/fonts/literata-latin-opsz-normal.woff2',
  '/fonts/literata-latin-opsz-italic.woff2',
  '/fonts/public-sans-latin-wght-normal.woff2',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { credentials: 'same-origin' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // network only, never cached
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  if (!SHELL.includes(key)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Never cache a redirect or an access-gateway login page in place of the shell.
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(key)
          .then(
            (hit) =>
              hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }),
          ),
      ),
  );
});
