/* 离线缓存策略（按资源性质分派）：
   - 版本串资源（?v=）、字体/图片切片、懒加载大件：缓存优先——内容不变（immutable），
     装成 APP 后不必每次都问网络，弱网/离线秒开；升级靠换版本串。
   - 篇 JSON（data/articles/*）：先回缓存秒开，后台取新写穿——读过的篇离线可重读，
     文字勘误下次打开即见（stale-while-revalidate）。
   - HTML / books.json：网络优先、写穿缓存，离线回退——目录与页面壳始终最新。
   - config.js：恒取网络（no-store），离线才回缓存。 */
const VER = 'wc-v73';   // v43 曾被已回滚的 07-12 重设计短暂占用，跳过避免缓存名撞车
                        // v70：修离线下载自伤（SWR 与「下载整册」重复回源 + 配额满仍空转重下）
// 用户主动"下载整册"的离线缓存：与外壳版本解耦，升版时不清除（见 activate）。
// 取数失败时 caches.match 会自动跨 cache 命中这里。
const DL = 'wc-dl';
// 注：opencc.js(1.1MB)/qrcode.js(55KB) 是懒加载件，不进首装清单——运行时缓存优先会在首次使用后自动离线可用；
// 塞进 SHELL 会让每个新访客装 SW 时白下 1.2MB，且 addAll 原子安装在弱网下更易整体失败。
const SHELL = ['./', 'index.html', 'css/app.css?v=20260926-app25', 'js/app.js?v=20260926-app25', 'js/ai-core.js?v=20260926-app25', 'js/reading-data.js?v=20260926-app25', 'js/share.js?v=20260926-app25', 'js/pwa.js?v=20260926-app25', 'js/offline.js?v=20260926-app25', 'config.js?v=20260926-app25', 'icon.svg', 'manifest.webmanifest', 'img/icons/icon-192.png', 'img/icons/maskable-192.png', 'apple-touch-icon.png', 'data/books.json'];

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

/* 带超时的取数。
   要点：fetch() 只在连接彻底失败时才 reject，而国内连境外 CDN 的典型故障不是
   「立刻失败」，是「连上了、请求发出去了、响应迟迟不回」——这时 fetch 既不返回
   也不抛错，会一直挂着。少了超时，下面 networkFirst 的 catch 分支就永不触发，
   缓存里明明存着昨天的首页也用不上，页面一直空白；装成 APP 后没有地址栏，
   用户连刷新都点不了，看到的就是「打不开」。这是必须有超时的原因，不是优化。 */
function fetchTimeout(req, ms, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const opts = Object.assign({}, init || {}, { signal: ctrl.signal });
  return fetch(req, opts).then(
    (res) => { clearTimeout(timer); return res; },
    (err) => { clearTimeout(timer); throw err; }
  );
}
const T_SHELL = 2500;   // HTML/目录：关键路径，宁可早回缓存也不让人干等
const T_JSON = 8000;    // 篇 JSON 约 8KB，给足弱网余量，但不允许无限挂起

// 命中即回；miss 才走网络并写缓存（immutable 资源）
// 注：此路靠 ?v= 版本串区分资源，caches.match 必须精确匹配，不能 ignoreSearch，
// 否则新版本会命中旧版本的缓存。字体等大件也不设超时，慢总比断好。
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(VER)).put(req, res.clone());
  return res;
}
// 先回缓存秒开，后台取新写穿；无缓存则等网络（篇 JSON）
async function staleWhileRevalidate(req, event) {
  /* 已主动下载的篇保持本机秒开。offline.js 联网获取内容摘要清单，
     在「管理离线」中显示待更新篇数，只替换校验通过的变动篇目；
     外壳升版保留下载内容，不再把换 VER 误当成正文更新机制。 */
  const pinned = await (await caches.open(DL)).match(req);
  if (pinned) return pinned;

  const hit = await caches.match(req);
  const refresh = fetchTimeout(req, T_JSON).then(async (res) => {
    if (res.ok) {
      const data = await res.clone().json();
      const id = new URL(req.url).pathname.split('/').pop().replace(/\.json$/, '');
      if (!data || data.id !== id || !Array.isArray(data.segments)) throw new Error('Invalid article response');
      try { await (await caches.open(VER)).put(req, res.clone()); } catch (err) {}
    }
    return res;
  });
  if (hit) {
    if (event) event.waitUntil(refresh.catch(() => {}));
    else refresh.catch(() => {});
    return hit;
  }
  return refresh;
}
// 网络优先写穿，离线（或网络卡死）回退缓存（HTML、目录）
async function networkFirst(req) {
  let networkResponse;
  try {
    networkResponse = await fetchTimeout(req, T_SHELL);
    if (networkResponse.ok) {
      // 缓存配额问题不能丢掉已经取得的可用网页。
      try { await (await caches.open(VER)).put(req, networkResponse.clone()); } catch (err) {}
      return networkResponse;
    }
  } catch (err) {}
  // HTML 与目录允许忽略启动查询串；版本资源不经过本分支。
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  // 分享链接/书签可直接冷启动未曾访问的篇页。正文已整册下载时，
  // 由通用阅读器外壳读取地址并打开本机 JSON，无需预存 2565 份 HTML。
  if (req.mode === 'navigate' && /^\/a\/[\w-]+\/?$/.test(new URL(req.url).pathname)) {
    const shell = await caches.match('/index.html') || await caches.match('/');
    if (shell) return shell;
  }
  if (networkResponse) return networkResponse;
  throw new Error('Offline resource unavailable');
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const p = url.pathname;
  // 安装包等分发大件：直连网络，绝不进离线缓存（一个 APK 就 1.4MB，挤占的是正文与字体的额度）
  if (p.startsWith('/app/')) return;
  // 启动计数像素：必须每次真的走网络，否则被缓存后服务端就再也数不到
  if (p.startsWith('/i/')) return;
  // config.js 恒取网络（配置改了要立刻生效），但它是阻塞式 <script>：网络卡住
  // 就卡住整个页面解析。故同样设超时，超时即用缓存里的上一份，宁可配置旧一轮。
  if (p.endsWith('/config.js')) {
    e.respondWith(
      fetchTimeout(e.request, T_SHELL, { cache: 'no-store' })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
    return;
  }
  const immutable = url.searchParams.has('v') || p.startsWith('/font/') || p.startsWith('/img/')
    || p === '/js/opencc.js' || p === '/js/qrcode.js';
  if (immutable) { e.respondWith(cacheFirst(e.request)); return; }
  /* 「下载整册」发出的预取：直连网络，不进 SWR。
     否则 offline.js 每篇会触发两次回源（它自己一次 + 这里复验一次）。
     它拿到响应后会自己 put 进 wc-dl，此处不必也不应再写一份进 VER 缓存。 */
  if (e.request.headers.get('X-WC-Prefetch')) return;
  if (p.startsWith('/data/articles/')) { e.respondWith(staleWhileRevalidate(e.request, e)); return; }
  e.respondWith(networkFirst(e.request));
});
