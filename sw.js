// Fry's Ledger service worker: caches the app shell so it opens with no signal. Data always goes to the network.
const CACHE = 'frys-ledger-v0.5';
const SHELL = ['./', './index.html', './app.js', './config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './vendor/html5-qrcode.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.includes('/rest/v1/') || u.pathname.includes('/auth/v1/') || u.pathname.includes('/storage/v1/')) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { if (res && res.ok && res.type !== 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; })));
});
