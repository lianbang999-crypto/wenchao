/* 离线缓存：一律网络优先、写穿缓存；离线时回退缓存。
   读过的篇目离线可重读，数据更新后在线立即生效。 */
const VER = 'wc-v48';   // v43 曾被已回滚的 07-12 重设计短暂占用，跳过避免缓存名撞车
// 用户主动"下载整册"的离线缓存：与外壳版本解耦，升版时不清除（见 activate）。
// 取数失败时下方 fetch 处理器的 caches.match 会自动跨 cache 命中这里。
const DL = 'wc-dl';
// 注：opencc.js(1.1MB)/qrcode.js(55KB) 是懒加载件，不进首装清单——运行时写穿缓存会在首次使用后自动离线可用；
// 塞进 SHELL 会让每个新访客装 SW 时白下 1.2MB，且 addAll 原子安装在弱网下更易整体失败。
const SHELL = ['./', 'index.html', 'css/app.css?v=20260810-fnt1', 'js/app.js?v=20260810-fnt1', 'js/ai-core.js', 'js/share.js?v=20260810-fnt1', 'js/pwa.js?v=20260810-fnt1', 'js/offline.js?v=20260810-fnt1', 'config.js?v=20260810-fnt1', 'icon.svg', 'manifest.webmanifest', 'img/icons/icon-192.png', 'img/icons/maskable-192.png', 'apple-touch-icon.png', 'data/books.json'];

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
