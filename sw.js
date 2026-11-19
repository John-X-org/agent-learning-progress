/* sw.js — 只缓存外壳，绝不缓存 /.cloud/ 数据请求 */
const CACHE = 'alp-shell-v1';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/api.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/.cloud/')) return;          // 数据请求永不缓存
  if (url.origin !== location.origin) return;               // CDN 交给浏览器

  // 外壳：网络优先，失败回落缓存（保证发布后能拿到新版本）
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
