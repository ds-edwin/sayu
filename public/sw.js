const BASE = new URL('./', self.location.href);
const PREFIX = 'sayu-offline-' + BASE.pathname + '-';
const CACHE=PREFIX+'v04';
const asset = path => new URL(path, BASE).href;
self.addEventListener('install', event => event.waitUntil((async () => {
  const response = await fetch(asset('pwa-precache.json'), {cache: 'no-store'});
  if (!response.ok) throw Error('Precache unavailable');
  const cache = await caches.open(CACHE);
  await cache.addAll((await response.json()).map(asset));
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== BASE.origin) return;
  const entry = url.pathname === BASE.pathname || url.pathname === BASE.pathname + 'index.html';
  if (event.request.mode === 'navigate' && entry) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(asset('index.html')) || fetch(event.request);
    })());
    return;
  }
  if (url.pathname.startsWith(BASE.pathname + 'pwa-assets/') ||
      ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'offline.html'].some(p => url.pathname === BASE.pathname + p)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(event.request) || fetch(event.request);
    })());
  }
});
