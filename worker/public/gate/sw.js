// Keeps the gate working with no signal: the page and its files are saved on the phone. Always tries the network
// first (so updates arrive as soon as there is a connection) and falls back to the saved copy. API calls are never
// cached here; the page keeps its own data.
const CACHE = 'tapin-gate-v1';
const SHELL = ['/gate/', '/gate/gate.js', '/gate/gate.css', '/js/offline.js', '/css/tapin.css', '/css/fx.css', '/js/theme.js', '/js/fx.js', '/js/liquid.js', '/js/dom.js', '/js/api.js', '/logo/tap-in-app-icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tapin-gate-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first; on a weak signal, the saved copy after 4 seconds; with no signal, the saved copy at once.
  const fromCache = () => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('/gate/') : undefined));
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (res) => { if (!done) { done = true; resolve(res); } };
    const timer = setTimeout(() => fromCache().then((hit) => hit && finish(hit)), 4000);
    fetch(e.request)
      .then((res) => {
        clearTimeout(timer);
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        finish(res);
      })
      .catch(() => { clearTimeout(timer); fromCache().then((hit) => finish(hit || Response.error())); });
  }));
});
