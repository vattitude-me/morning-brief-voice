// Offline shell: our static files network-first with a cache fallback.
// Supabase (data, audio) and CDN requests are cross-origin and go straight to the network.
const CACHE = 'morning-brief-v28';
const SHELL = ['/', '/config.js', '/css/styles.css', '/js/app.js', '/js/api.js', '/js/storypack.js', '/js/player.js', '/js/sheets.js', '/js/landing.js',
  '/js/design.js', '/js/pages/sources.js', '/js/pages/settings.js', '/js/pages/admin.js',
  '/icons/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Audio streams with range requests; let the browser handle it directly.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.mp3')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* plain-text payload */ }
  e.waitUntil(self.registration.showNotification(data.title || 'Morning Brief', {
    body: data.body || "Today's briefing is ready.",
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'morning-brief',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if ('focus' in w) return w.focus();
    return self.clients.openWindow(target);
  }));
});
