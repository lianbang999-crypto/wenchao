/* 离线缓存策略（按资源性质分派）：
   - 版本串资源（?v=）、字体/图片切片、懒加载大件：缓存优先——内容不变（immutable），
     装成 APP 后不必每次都问网络，弱网/离线秒开；升级靠换版本串。
   - 篇 JSON（data/articles/*）：先回缓存秒开，后台取新写穿——读过的篇离线可重读，
     文字勘误下次打开即见（stale-while-revalidate）。
   - HTML / books.json：网络优先、写穿缓存，离线回退——目录与页面壳始终最新。
   - config.js：恒取网络（no-store），离线才回缓存。 */
const VER = 'wc-v60';   // v43 曾被已回滚的 07-12 重设计短暂占用，跳过避免缓存名撞车
// 用户主动"下载整册"的离线缓存：与外壳版本解耦，升版时不清除（见 activate）。
// 取数失败时 caches.match 会自动跨 cache 命中这里。
const DL = 'wc-dl';
// 注：opencc.js(1.1MB)/qrcode.js(55KB) 是懒加载件，不进首装清单——运行时缓存优先会在首次使用后自动离线可用；
// 塞进 SHELL 会让每个新访客装 SW 时白下 1.2MB，且 addAll 原子安装在弱网下更易整体失败。
const SHELL = ['./', 'index.html', 'css/app.css?v=20260817-app12', 'js/app.js?v=20260817-app12', 'js/ai-core.js', 'js/share.js?v=20260817-app12', 'js/pwa.js?v=20260817-app12', 'js/offline.js?v=20260817-app12', 'config.js?v=20260817-app12', 'icon.svg', 'manifest.webmanifest', 'img/icons/icon-192.png', 'img/icons/maskable-192.png', 'apple-touch-icon.png', 'data/books.json'];

/* 装好即等待，不抢先接管。
   原先 install 就 skipWaiting：用户正读着，新版本一到便强行换人并清掉旧缓存，
   此时若去取下一篇，可能拿到新旧混着的文件甚至取空。改为等页面提示、用户点了
   「刷新」再切（见 app.js 的更新条）；用户不理会也无妨，下次冷启动自然是新版。 */
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)));
});
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VER && k !== DL).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 命中即回；miss 才走网络并写缓存（immutable 资源）
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(VER)).put(req, res.clone());
  return res;
}
// 先回缓存秒开，后台取新写穿；无缓存则等网络（篇 JSON）
async function staleWhileRevalidate(req) {
  const hit = await caches.match(req);
  const refresh = fetch(req).then(async (res) => {
    if (res.ok) (await caches.open(VER)).put(req, res.clone());
    return res;
  });
  if (hit) { refresh.catch(() => {}); return hit; }
  return refresh;
}
// 网络优先写穿，离线回退缓存（HTML、目录）
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(VER)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const p = url.pathname;
  // 安装包等分发大件：直连网络，绝不进离线缓存（一个 APK 就 1.4MB，挤占的是正文与字体的额度）
  if (p.startsWith('/app/')) return;
  // 启动计数像素：必须每次真的走网络，否则被缓存后服务端就再也数不到
  if (p.startsWith('/i/')) return;
  if (p.endsWith('/config.js')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request)));
    return;
  }
  const immutable = url.searchParams.has('v') || p.startsWith('/font/') || p.startsWith('/img/')
    || p === '/js/opencc.js' || p === '/js/qrcode.js';
  if (immutable) { e.respondWith(cacheFirst(e.request)); return; }
  if (p.startsWith('/data/articles/')) { e.respondWith(staleWhileRevalidate(e.request)); return; }
  e.respondWith(networkFirst(e.request));
});
