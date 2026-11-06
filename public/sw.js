/* Leonida Drive repeat-launch cache. No API, multiplayer or user-state responses are cached. */
const CACHE = 'leonida-runtime-v1';
const STATIC = /\/(?:assets|data)\/|\/(?:icon-192\.png|icon-512\.png|manifest\.webmanifest)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('leonida-runtime-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function warm(urls) {
  const cache = await caches.open(CACHE);
  // Small batches avoid a large transient network/heap spike on slower phones.
  for (let i = 0; i < urls.length; i += 4) {
    await Promise.all(urls.slice(i, i + 4).map(async (url) => {
      try {
        if (await cache.match(url)) return;
        const response = await fetch(url, { credentials: 'same-origin' });
        if (response.ok && (response.type === 'basic' || response.type === 'default')) await cache.put(url, response);
      } catch { /* a warm cache is best-effort; normal network loading remains available */ }
    }));
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'WARM_URLS' || !Array.isArray(event.data.urls)) return;
  const urls = [...new Set(event.data.urls.filter((u) => {
    try { const url = new URL(u, self.location.href); return url.origin === self.location.origin && (STATIC.test(url.pathname) || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')); }
    catch { return false; }
  }))];
  event.waitUntil(warm(urls));
});

self.addEventListener('fetch', (event) => {
  const rq = event.request;
  if (rq.method !== 'GET') return;
  const url = new URL(rq.url);
  if (url.origin !== self.location.origin) return;
  if (rq.mode === 'navigate') {
    // Instant repeat navigation; revalidate in the background so a later launch can update.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(rq, { ignoreSearch: false }) || await cache.match(self.registration.scope);
      const fresh = fetch(rq).then((response) => {
        if (response.ok) cache.put(rq, response.clone());
        return response;
      }).catch(() => null);
      return cached || await fresh || fetch(rq);
    })());
    return;
  }
  if (!STATIC.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(rq);
    if (cached) return cached;
    const response = await fetch(rq);
    if (response.ok && (response.type === 'basic' || response.type === 'default')) await cache.put(rq, response.clone());
    return response;
  })());
});
