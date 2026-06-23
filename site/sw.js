/* 离线缓存：一律网络优先、写穿缓存；离线时回退缓存。
   读过的篇目离线可重读，数据更新后在线立即生效。 */
const VER = 'wc-v35';
// 用户主动"下载整册"的离线缓存：与外壳版本解耦，升版时不清除（见 activate）。
// 取数失败时下方 fetch 处理器的 caches.match 会自动跨 cache 命中这里。
const DL = 'wc-dl';
const SHELL = ['./', 'index.html', 'css/app.css?v=20260623-600q', 'js/app.js?v=20260623-600q', 'js/ai-core.js', 'js/qrcode.js', 'js/share.js?v=20260621-aicard2', 'js/opencc.js?v=20260616-ai-v2', 'js/pwa.js?v=20260622-pwa', 'js/offline.js?v=20260622-offline', 'config.js?v=20260616-ai-panel', 'icon.svg', 'manifest.webmanifest', 'img/icons/icon-192.png', 'img/icons/maskable-192.png', 'apple-touch-icon.png', 'data/books.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VER && k !== DL).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VER).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
