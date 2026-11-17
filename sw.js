// Offline support.
// - App shell and the bundled data/ copies: served from the cache straight away and refreshed
//   in the background (stale-while-revalidate). A changed file shows the "Herladen" banner.
// - uov.json and times.json from the R2 bucket (js/config.js, DATA_URL): the same, but in their own
//   cache that survives app updates, and without the banner (new data isn't a new app version).
// - Cat gifs: cache-first, in their own cache.
// Bump VERSION when the list of files below changes.

const VERSION = 'v12';
const SHELL = `uov-shell-${VERSION}`;
const CATS = 'uov-cats';
const DATA = 'uov-data';

const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/mithril.min.js',
  'vendor/mithril.LICENSE',
  'js/app.js',
  'js/config.js',
  'js/lib.js',
  'js/mascot.js',
  'js/messages.js',
  'js/storage.js',
  'data/uov.json',
  'data/times.json',
  'cats/cats.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('uov-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
    precacheCats(); // best effort, not awaited
  })());
});

async function precacheCats() {
  try {
    const list = await (await fetch('cats/cats.json', { cache: 'no-cache' })).json();
    const cache = await caches.open(CATS);
    const files = list.map((c) => (typeof c === 'string' ? c : c.file)).filter(Boolean);
    const wanted = new Set(files.map((f) => new URL(`cats/${f}`, self.registration.scope).href));
    for (const req of await cache.keys()) if (!wanted.has(req.url)) await cache.delete(req);
    for (const url of wanted) if (!(await cache.match(url))) await cache.add(url).catch(() => {});
  } catch { /* offline or no list: try again next time */ }
}

self.addEventListener('message', (event) => {
  if (event.data === 'precache-cats') event.waitUntil(precacheCats());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) {
    // Data from the bucket; anything else cross-origin (e.g. the U-OV form) is left alone.
    if (/\/(uov|times)\.json$/.test(url.pathname)) event.respondWith(staleWhileRevalidate(DATA, request.url, request, event, false));
    return;
  }

  if (url.pathname.includes('/cats/') && !url.pathname.endsWith('.json')) {
    event.respondWith(cacheFirst(CATS, request));
    return;
  }
  // Navigations (also with ?query) get the cached app page.
  const key = request.mode === 'navigate' ? 'index.html' : request;
  event.respondWith(staleWhileRevalidate(SHELL, key, request, event));
});

/** Did a file really change? Cheap header check first, then compare the content. */
async function changed(cached, fresh) {
  const tag = (r) => r.headers.get('etag') || r.headers.get('last-modified') || '';
  if (tag(cached) && tag(cached) === tag(fresh)) return false;
  const [a, b] = await Promise.all([cached.clone().arrayBuffer(), fresh.clone().arrayBuffer()]);
  if (a.byteLength !== b.byteLength) return true;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return true;
  return false;
}

/** Tell open pages that a newer version is stored; they show a "reload" banner. */
async function notifyUpdate() {
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'update-available' });
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(cacheName, key, request, event, notify = true) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
  const update = fetch(request, { cache: 'no-cache' })
    .then(async (res) => {
      if (res.ok) {
        if (notify && hit && await changed(hit, res)) notifyUpdate();
        await cache.put(key, res.clone());
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(update);
    return hit;
  }
  return (await update) || new Response('Offline', { status: 503, statusText: 'Offline' });
}
