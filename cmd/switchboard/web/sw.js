'use strict';

// Keeps the app's own files available if the server is briefly unreachable.
// Network first, so a new release is picked up as soon as you are online.
// Nothing under /api/ is ever cached, and WebSockets bypass service workers.

const CACHE = 'switchboard-shell-v1';
const SHELL = [
  '/', '/style.css', '/app.js', '/workspace.js', '/rdp.js',
  '/vendor/xterm.css', '/vendor/xterm.js', '/vendor/addon-fit.js', '/vendor/guacamole-common.js',
  '/icon.svg', '/icon-192.png', '/manifest.webmanifest',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/'))),
  );
});
