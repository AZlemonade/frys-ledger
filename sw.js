// Fry's Ledger service worker: caches the app shell so it opens with no signal. Data always goes to the network.
const CACHE = 'frys-ledger-v1.0';
const SHELL = ['./', './index.html', './app.js', './config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './vendor/html5-qrcode.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.includes('/rest/v1/') || u.pathname.includes('/auth/v1/') || u.pathname.includes('/storage/v1/')) return;
  const keep = res => { if (res && res.ok && res.type !== 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; };
  // The report and upload pages are used at a desk with signal: always fresh, cache only as a fallback.
  if (/\/(report|count)\//.test(u.pathname)) {
    e.respondWith(fetch(e.request).then(keep).catch(() => caches.match(e.request)));
    return;
  }
  // The app is used in stores with bad signal: answer from the cache at once and refresh it behind
  // the scenes, so a new version arrives on the next launch without anyone clearing anything.
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(keep).catch(() => hit);
    return hit || net;
  }));
});
