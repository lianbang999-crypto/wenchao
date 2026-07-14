/* ===================================================================
   印光法师文钞 · 文白对照 阅读器
   纯前端、无构建：books.json 目录树 + articles/{id}.json 按篇懒加载
   =================================================================== */

import { aiFormat, citationExcerpt, aiSpeakToggle, aiSpeakStop, verifyBadgeHTML,
  FB_ICON, citeHover, copyText, appendVerify, localPron } from './ai-core.js';

const $ = (s) => document.querySelector(s);
const CFG = window.WENCHAO_CONFIG || {};

/* ---------- 持久化偏好 ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('wc.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wc.' + k, JSON.stringify(v)); } catch {} },
};
const prefs = {
  fs: store.get('fs', 17),
  theme: store.get('theme', 'paper'),
  mode: store.get('mode', 'both'),     // orig | trans | both
  trad: store.get('trad', false),      // 繁体显示（OpenCC 简→繁，仅显示层）
};
const progress = store.get('progress', {});   // {id: {pct, t}}
let lastRead = store.get('lastRead', null);   // {id, title}
// 收藏（书签）：整篇加星。{id: {t:篇名, v:分册, ts}}。键 wc.bookmarks，模型对齐主站 fy.bk 便于并站。
let bookmarks = store.get('bookmarks', {});
// 划线（用户高亮）：每篇一条数组 wc.hl.<id> = [{p 段序, s/e 段内字符偏移, t 摘句}]（换字号/设备不漂移，对齐主站 fy.hl）
const getHls = (id) => store.get('hl.' + id, []);
const setHls = (id, arr) => store.set('hl.' + id, arr);

/* ---------- 全局状态 ---------- */
let books = [];          // 目录树
let flat = [];           // 扁平篇目序（上一篇/下一篇用）
let current = null;      // 当前文章 JSON
const articleCache = new Map();

/* ---------- 工具 ---------- */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const articleHref = (id, p) => {
  const q = p !== undefined && p !== null && p !== '' && !Number.isNaN(Number(p))
    ? '?p=' + encodeURIComponent(p)
    : '';
  return '/a/' + encodeURIComponent(id) + '/' + q;
};
function goArticle(id, p) {
  if (!id) return;
  const href = articleHref(id, p);
  if (location.pathname + location.search !== href || location.hash) {
    history.pushState(null, '', href);
  }
  route();
}
function goHome() {
  if (location.pathname !== '/' || location.search || location.hash) {
    history.pushState(null, '', '/');
  }
  route();
}
// 「我的」页用 hash 路由（静态站无 SPA 回退，hash 直链也能命中）；强制路径为 /，避开文章路由
function goMine() {
  if (location.pathname !== '/' || location.hash !== '#me') history.pushState(null, '', '/#me');
  route();
}
/* 卷名缩写：「增广印光法师文钞卷第一」→「卷第一」 */
const shortJuan = (j) => j.replace(/^(增广)?印光法师文钞(续编|三编)?/, '') || j;

/* 底色主题表：id → { data-theme 属性值, 浏览器 UI 主题色 } */
const THEMES = {
  paper: { attr: '',      color: '#f6f1e6' },  /* 纸色（默认） */
  plain: { attr: 'plain', color: '#e8e7e3' },  /* 素白 · 墨水屏 */
  night: { attr: 'night', color: '#171310' },  /* 墨夜 */
};

function applyPrefs() {
  document.documentElement.style.setProperty('--fs', prefs.fs + 'px');
  const t = THEMES[prefs.theme] || THEMES.paper;
  document.documentElement.dataset.theme = t.attr;
  document.querySelector('meta[name=theme-color]').setAttribute('content', t.color);
  // 偏好按钮现渲染于「我的」页（动态存在）→ 全部按需切换，不在页时安全跳过
  const tog = (sel, on) => { const el = $(sel); if (el) el.classList.toggle('on', on); };
  tog('#theme-paper', prefs.theme === 'paper');
  tog('#theme-plain', prefs.theme === 'plain');
  tog('#theme-night', prefs.theme === 'night');
  tog('#cc-simp', !prefs.trad);
  tog('#cc-trad', prefs.trad);
}

/* ---------- 抽屉 ---------- */
const drawerL = $('#drawer-left'), drawerR = $('#drawer-right'), overlay = $('#overlay');
const isWide = () => matchMedia('(min-width: 1180px)').matches;

function openDrawer(side) {
  stopRead();        // 打开目录/AI：停读，腾出注意力
  if (isWide() && side === 'L') return;
  (side === 'L' ? drawerL : drawerR).classList.add('open');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('show'));
}
function closeDrawers() {
  drawerL.classList.remove('open');
  drawerR.classList.remove('open');
  overlay.classList.remove('show');
  setTimeout(() => { overlay.hidden = true; }, 280);
  aiSpeakStop();   // 关面板即停 AI 回答朗读（高清音频 + 本机合成）
}
$('#btn-nav').onclick = () => openDrawer('L');
$('#btn-ai').onclick = () => openDrawer('R');
$('#btn-ai-close').onclick = closeDrawers;
overlay.onclick = closeDrawers;
$('#topbar-title').onclick = () => { goHome(); closeDrawers(); };
{ const sh = $('#seal-home'); if (sh) sh.onclick = () => { goHome(); closeDrawers(); }; }   // 左上角「文钞」印章 → 回首页
{ const bm = $('#btn-mine'); if (bm) bm.onclick = () => { goMine(); closeDrawers(); }; }   // 右上角人形 →「我的」页

/* 边缘滑动手势：左缘右滑开目录，右缘左滑开AI；抽屉上反向滑动关闭 */
let touch = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touch = { x: t.clientX, y: t.clientY, t: Date.now() };
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touch || isWide()) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x, dy = t.clientY - touch.y, dt = Date.now() - touch.t;
  touch = null;
  if (dt > 600 || Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
  const fromL = (e.target.closest && e.target.closest('#drawer-left'));
  const fromR = (e.target.closest && e.target.closest('#drawer-right'));
  if (drawerL.classList.contains('open')) { if (dx < 0 || fromL && dx < 0) closeDrawers(); return; }
  if (drawerR.classList.contains('open')) { if (dx > 0) closeDrawers(); return; }
  if (dx > 0 && touchStartNearEdge(e, 'left')) openDrawer('L');
  else if (dx < 0 && touchStartNearEdge(e, 'right')) openDrawer('R');
}, { passive: true });
let edgeStart = 0;
document.addEventListener('touchstart', (e) => { edgeStart = e.touches[0].clientX; }, { passive: true });
const touchStartNearEdge = (e, side) =>
  side === 'left' ? edgeStart < 32 : edgeStart > innerWidth - 32;

/* ---------- 全文检索：篇名本地过滤 + 正文查后端 D1 全文索引 ----------
   不再下载整站语料（曾是 15MB 的 search.json，全量拉取+客户端线性扫描）；
   正文一路改为调用 workers/ai-proxy 的 /search，复用 RAG 已建的 D1 全文索引，
   只传回命中篇目与摘录。篇名一路仍走本地 flat 数组，瞬时、不需要请求。 */
let pendingFind = '';

// 高亮片段渲染：服务端只回传一小段纯文本摘录，转义与 <mark> 包裹在前端做
function buildSnip(raw, kw) {
  if (!raw) return '';
  const idx = raw.indexOf(kw);
  if (idx === -1) return esc(raw);
  return esc(raw.slice(0, idx)) + '<mark>' + esc(kw) + '</mark>' + esc(raw.slice(idx + kw.length));
}

async function fullSearch(kw) {
  const tree = $('#nav-tree');
  tree.innerHTML = '<p class="nav-empty">正在搜索…</p>';
  const hits = [];
  const seen = new Set();
  for (const it of flat) {                 // 篇名匹配：本地过滤已加载目录，无需请求
    if (!it.title.includes(kw)) continue;
    seen.add(it.id);
    hits.push({ id: it.id, t: it.title, v: it.volName || '', snip: '' });
    if (hits.length >= 100) break;
  }
  let bodyFailed = false, indexEmpty = false;
  if (hits.length < 100) {                 // 正文匹配：查后端全文索引
    if (!CFG.aiEndpoint) {
      bodyFailed = true;
    } else {
      try {
        const res = await fetch(CFG.aiEndpoint.replace(/\/$/, '') + '/search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: kw }),
        });
        if (!res.ok) throw new Error('search ' + res.status);
        const data = await res.json();
        if (data.ready === false) indexEmpty = true;   // 后端正文索引未建（lexRows=0）
        for (const h of (data.hits || [])) {
          if (seen.has(h.i) || hits.length >= 100) continue;
          seen.add(h.i);
          hits.push({ id: h.i, t: h.t, v: h.v, snip: buildSnip(h.snip, kw) });
        }
      } catch { bodyFailed = true; }   // 网络/服务异常：仍展示篇名匹配结果
    }
  }
  // 空结果文案据实：索引未就绪 / 网络异常 / 确实没有，三者分开，不把"检索未开"说成"没找到"
  const empty = indexEmpty
    ? '正文全文检索尚未就绪，目前仅按篇名搜索。<br>想按义理找内容，可用右上角「问文钞」。'
    : bodyFailed
      ? '正文全文搜索暂不可用，请检查网络（也可只按篇名搜）'
      : '没有找到「' + esc(kw) + '」';
  tree.innerHTML = hits.length
    ? `<p class="search-count">共找到 ${hits.length}${hits.length >= 100 ? '+' : ''} 篇</p>` +
      hits.map((h) => `
      <button class="search-hit" data-id="${h.id}">
        <span class="sh-title">${esc(h.t)}</span><span class="sh-vol">${esc(h.v)}</span>
        ${h.snip ? `<span class="sh-snip">${h.snip}</span>` : ''}
      </button>`).join('')
    : `<p class="nav-empty">${empty}</p>`;
  tree.querySelectorAll('.search-hit').forEach((b) => {
    b.onclick = () => {
      pendingFind = kw;
      goArticle(b.dataset.id);
      closeDrawers();
    };
  });
}

/* 文章内定位高亮：把段落文本节点中的命中词包上 <mark> */
function markInRoot(root, kw) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) if (n.nodeValue.includes(kw)) nodes.push(n);
  let first = null;
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    const parts = node.nodeValue.split(kw);
    parts.forEach((p, i) => {
      frag.appendChild(document.createTextNode(p));
      if (i < parts.length - 1) {
        const m = document.createElement('mark');
        m.className = 'find-hit';
        m.textContent = kw;
        if (!first) first = m;
        frag.appendChild(m);
      }
    });
    node.parentNode.replaceChild(frag, node);
  }
  return first;
}

/* ---------- 目录树 ---------- */
function renderTree(filter) {
  const tree = $('#nav-tree');
  if (filter) {
    const kw = filter.trim();
    const hits = flat.filter((it) => it.title.includes(kw)).slice(0, 80);
    tree.innerHTML =
      `<button class="ft-btn" id="ft-go">全文搜索「${esc(kw)}」</button>` +
      (hits.length
        ? hits.map((it) => navItemHtml(it, true)).join('')
        : '<p class="nav-empty">无此篇名，可试全文搜索</p>');
    bindNavItems(tree);
    maybeTradify(tree);
    $("#ft-go").onclick = () => fullSearch(kw);
    return;
  }
  tree.innerHTML = books.map((vol) => {
    const count = vol.juans.reduce((n, j) => n + j.cats.reduce((m, c) => m + c.items.length, 0), 0);
    const juans = vol.juans.map((j) => {
      const items = j.cats.reduce((a, c) => a.concat(c.items), []);
      // 单篇且篇名即卷名 → 直接成项，免去"展开只见同名一篇"的冗余
      if (items.length === 1 && items[0].title === j.name) {
        return navItemHtml(items[0], false, true);
      }
      const cats = j.cats.map((c) =>
        (c.name && c.name !== '正文' ? `<div class="nav-cat-label">${esc(c.name)}</div>` : '') +
        c.items.map((it) => navItemHtml(it)).join('')
      ).join('');
      return `<details class="nav-juan"><summary><span class="tri"></span>${esc(shortJuan(j.name))}</summary>${cats}</details>`;
    }).join('');
    return `<details class="nav-vol" data-vol="${vol.id}"><summary><span class="tri"></span>${esc(vol.name)}<span class="count">${count}篇</span></summary>${juans}</details>`;
  }).join('');
  bindNavItems(tree);
  maybeTradify(tree);
}
// 目录显示用篇名：去掉卷首长标题尾部的编者注「（附录于后）」，正文页仍用全名
const navTitle = (t) => t.replace(/（附录于后）$/, '');
const navItemHtml = (it, withVol, asJuan) => {
  const visited = progress[it.id] ? ' visited' : '';
  const active = current && current.id === it.id ? ' active' : '';
  const juan = asJuan ? ' nav-juan-leaf' : '';
  const sub = withVol ? `<small style="color:var(--ink-3)"> · ${esc(it.volName || '')}</small>` : '';
  return `<button class="nav-item${juan}${visited}${active}" data-id="${it.id}">${esc(navTitle(it.title))}${sub}</button>`;
};
function bindNavItems(root) {
  root.querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => { goArticle(b.dataset.id); closeDrawers(); };
  });
}
function highlightNav() {
  $('#nav-tree').querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', !!current && b.dataset.id === current.id);
  });
  if (!current) return;
  // 展开当前篇所在分册
  const volEl = $(`.nav-vol[data-vol="${current.volume}"]`);
  if (volEl) volEl.open = true;
}
$('#nav-search').addEventListener('input', (e) => renderTree(e.target.value));

/* ---------- 路由 ---------- */
window.addEventListener('popstate', route);
window.addEventListener('hashchange', route);
function articleRoute() {
  const legacy = (location.hash || '').match(/^#\/a\/([\w-]+)(?:\?p=(\d+))?/);
  if (legacy) {
    history.replaceState(null, '', articleHref(legacy[1], legacy[2]));
    return { id: legacy[1], p: legacy[2] };
  }
  const m = location.pathname.match(/^\/a\/([\w-]+)\/?$/);
  if (!m) return null;
  const p = new URLSearchParams(location.search).get('p');
  if (location.pathname !== '/a/' + m[1] + '/') {
    history.replaceState(null, '', articleHref(m[1], p));
  }
  return { id: decodeURIComponent(m[1]), p };
}
async function route() {
  stopRead();        // 切篇/回首页：停掉正在进行的朗读，避免高亮/进度错位
  closeDrawers();
  closeAaSheet();    // 阅读设置 sheet 不跨页残留
  { const bm = $('#btn-mine'); if (bm) bm.classList.remove('on'); }   // 默认非「我的」态；renderMine 会再点亮
  // 影像陈列页：内容随静态页预渲染，app.js 不重绘，仅同步标题/繁体
  if (/^\/ying\/?$/.test(location.pathname)) {
    current = null;
    $('#topbar-title').textContent = '印祖法相';
    $('#ai-context').textContent = '基于印光法师文钞全集';
    maybeTradify($('#reader'));
    return;
  }
  // 「我的」页（hash 路由，仅在非文章路径下命中）
  if (location.hash === '#me' && !/^\/a\//.test(location.pathname)) {
    renderMine(); maybeTradify($('#reader')); return;
  }
  const r = articleRoute();
  if (!r) { renderHome(); maybeTradify($('#reader')); return; }
  await renderArticle(r.id);
  maybeTradify($('#reader'));     // 繁体模式：正文渲染后转换
  // 分享二维码深链：?p=N 进入文白对照并定位到所引段落（便于对照原文/白话；不改用户保存的模式）
  if (r.p !== null && r.p !== undefined && r.p !== '') {
    const ab = document.querySelector('#reader .art-body');
    if (ab && ab.querySelector('.p-trans')) ab.dataset.mode = 'both';
    scrollToPara(+r.p);
  }
}
// 滚动到正文第 n 段并短暂高亮（与 share.js paraIndexOf 同口径）
function scrollToPara(n) {
  const body = document.querySelector('#reader .art-body');
  if (!body) return;
  const ps = body.querySelectorAll('p.p-orig, p.p-trans');
  const el = ps[n];
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('para-flash');
  setTimeout(() => el.classList.remove('para-flash'), 2400);
}

/* ---------- 首页 ---------- */
// 继续阅读卡（首页与「我的」页共用）
function resumeCardHtml() {
  return lastRead && progress[lastRead.id]
    ? `<button class="resume-card" data-id="${lastRead.id}">
         <small>上次读到</small>
         <strong>${esc(lastRead.title)}</strong>
         <span class="pct">${Math.round((progress[lastRead.id].pct || 0) * 100)}%</span>
       </button>`
    : '';
}
// 收藏 / 划线两段列表 HTML（「我的」页用）
function mineListsHtml() {
  const bks = bookmarkList();
  const hls = allHighlights();
  const bkHtml = bks.length ? `
      <section class="home-mine">
        <h2 class="mine-h">收藏 · ${bks.length}</h2>
        <div class="mine-list">${bks.map((b) =>
          `<button class="mine-item" data-go="${esc(b.id)}"><span class="mi-title">${esc(b.t)}</span>${b.v ? `<span class="mi-sub">${esc(b.v)}</span>` : ''}</button>`).join('')}</div>
      </section>` : '';
  const hlHtml = hls.length ? `
      <section class="home-mine">
        <h2 class="mine-h">划线 · ${hls.length} 处</h2>
        <div class="mine-list">${hls.map((h) =>
          `<div class="mine-row"><button class="mine-item hl-item" data-go="${esc(h.id)}" data-p="${h.p}"><span class="mi-quote">「${esc(h.t)}${(h.t || '').length >= 40 ? '…' : ''}」</span><span class="mi-sub">${esc(h.title)}</span></button><button class="mi-del" data-del="${esc(h.id)}" data-p="${h.p}" data-s="${h.s}" aria-label="删除划线">×</button></div>`).join('')}</div>
      </section>` : '';
  return { bks, hls, bkHtml, hlHtml };
}
// 继续阅读 / 收藏 / 划线 条目的公共点击绑定；delRerender=删划线后重绘当前视图
function wireMineItems(root, delRerender) {
  const rc = root.querySelector('.resume-card');
  if (rc) rc.onclick = () => goArticle(rc.dataset.id);
  root.querySelectorAll('.mine-item[data-go]').forEach((b) => {
    b.onclick = () => goArticle(b.dataset.go, b.dataset.p);
  });
  root.querySelectorAll('.mi-del').forEach((b) => {
    b.onclick = () => { removeHighlight(b.dataset.del, +b.dataset.p, +b.dataset.s); delRerender(); };
  });
}

function renderHome() {
  current = null;
  document.body.classList.remove('nav-hidden');   // 回首页顶栏必现
  $('#topbar-title').textContent = '印光法师文钞';
  $('#ai-context').textContent = '基于印光法师文钞全集';
  const total = flat.length;
  // 首页＝目录 +「继续阅读」一张轻卡（续读是最高频动作，值得首屏一个入口）；
  // 收藏/划线等其余个人内容仍集中在「我的」页（右上人形图标进入）
  const vols = books.map((vol) => {
    const count = vol.juans.reduce((n, j) => n + j.cats.reduce((m, c) => m + c.items.length, 0), 0);
    return `<button class="vol-card" data-vol="${vol.id}">
        <span class="vol-name">${esc(vol.name)}</span>
        <span class="vol-group">${esc(vol.group)}</span>
        <span class="vol-count">${count} 篇</span>
      </button>`;
  }).join('');
  $('#reader').innerHTML = `
    <div class="home">
      <div class="home-hero">
        <span class="v-sub">文白对照 · 闻思修学</span>
        <h1 class="v-title" style="margin:0">印光法师文钞</h1>
        <span class="seal" aria-hidden="true">文钞</span>
      </div>
      ${resumeCardHtml()}
      <h2>${books.length} 部 · 共 ${total} 篇</h2>
      ${vols}
      <div class="home-extra">
        <a class="home-cta" href="/ying/">瞻礼 · 印祖法相与传印长老题词 →</a>
      </div>
      <p class="home-note">底本为《印光法师文钞》增广、续编、三编及三编补之文白对照本。文言原文与白话译文逐篇对照排录；正文中带朱点之词语，点按可查名相注释。<br>愿见闻者，同沾法益。</p>
    </div>`;
  paintProgress();
  { const rc = $('#reader .resume-card'); if (rc) rc.onclick = () => goArticle(rc.dataset.id); }
  document.querySelectorAll('.vol-card').forEach((b) => {
    b.onclick = () => {
      openDrawer('L');
      const el = $(`.nav-vol[data-vol="${b.dataset.vol}"]`);
      if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); }
    };
  });
}

// 「我的」页：继续阅读 · 收藏 · 划线 · 离线整册（右上人形图标为唯一入口）。
// 字号/底色/简繁已并入阅读器工具行「Aa」sheet——设置只有一个家，且在正文旁所见即所得。
function renderMine() {
  current = null;
  document.body.classList.remove('nav-hidden');
  $('#topbar-title').textContent = '我的';
  $('#ai-context').textContent = '基于印光法师文钞全集';
  const mb = $('#btn-mine'); if (mb) mb.classList.add('on');
  const resume = resumeCardHtml();
  const resumeSec = resume ? `<section class="home-mine"><h2 class="mine-h">继续阅读</h2>${resume}</section>` : '';
  const { bks, hls, bkHtml, hlHtml } = mineListsHtml();
  const empty = (!bks.length && !hls.length && !resume)
    ? `<p class="mine-empty">阅读时点篇首的「收藏」、或选中文字「划线」，都会收进这里；上次读到的位置也会出现在「继续阅读」。</p>`
    : '';
  const settings = `
      <section class="home-mine mine-set">
        <h2 class="mine-h">离线</h2>
        <div class="set-card">
          <div class="set-row"><span class="set-k">整册离线</span><span class="set-c">
            <button class="chip-btn" id="offline-open">下载整册</button></span></div>
        </div>
      </section>`;
  $('#reader').innerHTML = `
    <div class="home mine-page">
      ${resumeSec}
      ${bkHtml}${hlHtml}${empty}
      ${settings}
    </div>`;
  paintProgress();
  wireMineItems($('#reader'), renderMine);
  if (window.__wcOfflineWire) window.__wcOfflineWire();   // 离线「下载整册」由 offline.js 挂载
}

/* ---------- 文章 ---------- */
async function loadArticle(id) {
  if (articleCache.has(id)) return articleCache.get(id);
  const res = await fetch('/data/articles/' + id + '.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('载入失败');
  const a = await res.json();
  articleCache.set(id, a);
  return a;
}

/* 在原文段中为本篇注释词条加下划点标（只标每词首次出现） */
function markTerms(text, terms, seen) {
  let html = esc(text);
  for (const t of terms) {
    if (seen.has(t.term)) continue;
    const i = html.indexOf(t.term);
    if (i === -1) continue;
    seen.add(t.term);
    html = html.slice(0, i) +
      `<button class="term" data-note="${t.key}">${t.term}</button>` +
      html.slice(i + t.term.length);
  }
  return html;
}

/* 行内注释角标：白话版底本正文自带 [n] 标记 → 可点上标 */
function addRefs(html, hasNotes) {
  if (!hasNotes) return html;
  return html.replace(/\[(\d{1,3})\]/g, '<sup class="note-ref" data-n="$1">$1</sup>');
}

/* 条目出处行：已链接的（嘉言录→文钞）可点跳转 */
function segSrcHtml(seg) {
  return seg.srcId
    ? `<button class="seg-src linked" data-go="${seg.srcId}">${esc(seg.src)}</button>`
    : `<div class="seg-src">${esc(seg.src)}</div>`;
}

async function renderArticle(id) {
  const reader = $('#reader');
  reader.innerHTML = '<p class="loading">展 卷 …</p>';
  let art;
  try { art = await loadArticle(id); }
  catch {
    reader.innerHTML = '<p class="loading">此篇载入失败，请检查网络后重试</p>';
    return;
  }
  current = art;
  $('#topbar-title').textContent = art.title;
  $('#ai-context').textContent = '基于印光法师文钞全集';

  // 本篇全部注释（带词条的参与正文标记）
  const allNotes = [];
  art.segments.forEach((s, si) => s.notes.forEach((n, ni) => {
    allNotes.push({ ...n, key: si + '-' + ni });
  }));
  const termNotes = allNotes.filter((n) => n.term)
    .sort((a, b) => b.term.length - a.term.length);
  const seen = new Set();

  const hasNotes = allNotes.length > 0;
  // 面包屑：首页 › 分册聚合页 › 本篇（前两级为链接，与预渲染同口径，点击走原生导航到静态聚合页）
  const crumbRest = [shortJuan(art.juan || ''), art.category, art.translator]
    .filter(Boolean).map(esc).join(' · ');
  const crumbHtml = '<a href="/">文钞</a>'
    + (art.volumeName
        ? ' · ' + (art.volume
            ? `<a href="/v/${encodeURIComponent(art.volume)}/">${esc(art.volumeName)}</a>`
            : esc(art.volumeName))
        : '')
    + (crumbRest ? ' · ' + crumbRest : '');

  let body = '';
  for (const seg of art.segments) {
    const paired = !art.plain && seg.trans.length === seg.orig.length && seg.orig.length > 0;
    if (art.plain) {
      body += seg.orig.map((p) => `<p class="p-orig" style="text-indent:0">${esc(p)}</p>`).join('');
      continue;
    }
    if (paired) {
      for (let i = 0; i < seg.orig.length; i++) {
        body += `<div class="para-pair">
          <p class="p-orig">${addRefs(markTerms(seg.orig[i], termNotes, seen), hasNotes)}</p>
          <p class="p-trans">${addRefs(esc(seg.trans[i]), hasNotes)}</p>
        </div>`;
      }
      if (seg.src) body += segSrcHtml(seg);
    } else {
      // 段数不等：按原文块/白话块分组呈现（不强行配对，忠于底本）。
      // 仅当两侧都有内容时才显示块标签；单侧段组直接连排
      const both = seg.orig.length && seg.trans.length;
      if (seg.orig.length) {
        if (both) body += '<div class="block-label">原 文</div>';
        body += seg.orig.map((p) => `<p class="p-orig">${addRefs(markTerms(p, termNotes, seen), hasNotes)}</p>`).join('');
      }
      if (seg.trans.length) {
        if (both) body += '<div class="block-label">白 话</div>';
        body += seg.trans.map((p) => `<p class="p-trans">${addRefs(esc(p), hasNotes)}</p>`).join('');
      }
      if (seg.src) body += segSrcHtml(seg);
    }
  }

  const notesHtml = allNotes.length
    ? `<section class="notes-sec"><h3>注 释</h3>${allNotes.map((n) =>
        `<p class="note-item" id="note-${n.key}">
           <span class="note-n">[${n.n}]</span>
           ${n.term ? `<span class="note-term">【${esc(n.term)}】</span>` : ''}
           ${esc(n.text)}
         </p>`).join('')}</section>`
    : '';

  // 反向链接：本篇被嘉言录选录（文钞篇 → 嘉言录条目）
  const backHtml = (art.backrefs && art.backrefs.length)
    ? `<section class="backrefs"><h3>入选《嘉言录》</h3>${art.backrefs.map((r) =>
        `<button class="backref" data-go="${r.a}">
           <span class="br-arrow">❖</span>${esc(r.t)}
           ${r.n > 1 ? `<span class="br-n">${r.n} 则</span>` : ''}
         </button>`).join('')}</section>`
    : '';

  // 上一篇 / 下一篇
  const idx = flat.findIndex((it) => it.id === id);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
  const navHtml = `<nav class="art-nav">
      ${prev ? `<button data-id="${prev.id}"><small>上一篇</small>${esc(prev.title)}</button>` : '<span></span>'}
      ${next ? `<button data-id="${next.id}"><small>下一篇</small>${esc(next.title)}</button>` : '<span></span>'}
    </nav>`;

  const hasTrans = art.segments.some((s) => s.trans.length);
  const canSeg = !art.plain && hasTrans;
  // 篇内工具行（吸顶，随沉浸模式同顶栏隐现）——阅读器唯一功能面，两行居中：
  // 上行＝分层条（全篇恒显统一风格；无白话篇 对照/白话 置灰，点按轻提示）；
  // 下行＝朗读 · 收藏 · Aa（本篇动作 + 阅读设置，不占顶栏——顶栏恒定：目录·标题·问文钞·我的）
  const segOff = canSeg ? '' : ' seg-off" aria-disabled="true';
  const segsHtml = `<div class="mb-segs" role="tablist">
        <button class="seg" data-m="orig">原文</button>
        <button class="seg${segOff}" data-m="both">对照</button>
        <button class="seg${segOff}" data-m="trans">白话</button>
      </div>`;
  const modeBar = `<div class="mode-bar">
      ${segsHtml}
      <div class="mb-acts">
        <button class="mb-act mb-speak" aria-label="朗读本篇">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a4.5 4.5 0 0 1 0 7"/></svg></button>
        <span class="mb-dot" aria-hidden="true">·</span>
        <button class="mb-act mb-bookmark" aria-label="收藏本篇" aria-pressed="false">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg></button>
        <span class="mb-dot" aria-hidden="true">·</span>
        <button class="mb-act mb-aa" aria-label="阅读设置"><span class="mb-aa-g">Aa</span></button>
      </div>
    </div>`;

  // 《文钞》选读：圆净所列初机必读篇目，分组呈现，可链接者点按直达文钞原篇
  const xuanduHtml = (art.xuandu && art.xuandu.length)
    ? `<div class="xuandu">${art.xuandu.map((sec) =>
        `<h3 class="xd-sec">${esc(sec.sec)}</h3>` +
        sec.items.map((it) => it.aid
          ? `<button class="xd-link${it.m ? ' xd-mark' : ''}" data-id="${esc(it.aid)}">${esc(it.t)}</button>`
          : `<span class="xd-item${it.m ? ' xd-mark' : ''}">${esc(it.t)}</span>`).join('')
      ).join('')}</div>`
    : '';

  reader.innerHTML = `<div class="reader-inner">
      ${modeBar}
      <header class="art-head">
        <div class="art-crumb">${crumbHtml}</div>
        <h1 class="art-title">${esc(art.title)}</h1>
        <div class="rule"></div>
      </header>
      ${art.summary ? `<div class="art-summary"><b>提 要</b>${esc(art.summary)}</div>` : ''}
      <article class="art-body" data-mode="${hasTrans ? prefs.mode : 'orig'}">${body}</article>
      ${xuanduHtml}
      ${notesHtml}
      ${backHtml}
      ${navHtml}
    </div>`;

  // 供分享卡读取：书名（系列正名，去掉「 · 十编主题分类」等副标题）+ 篇名
  const _bk = books.find((b) => b.id === art.volume) || {};
  window.__wcShare = {
    book: ((_bk.group || art.volumeName || '').split(/\s*·\s*/)[0] || '').trim(),
    title: art.title || '',
  };

  // 模式切换（无白话篇：分层条恒显但仅「原文」可用，点灰键轻提示）
  reader.querySelectorAll('.mode-bar .seg').forEach((b) => {
    b.classList.toggle('on', b.dataset.m === (canSeg ? prefs.mode : 'orig'));
    b.onclick = () => {
      if (b.classList.contains('seg-off')) { toast('本篇暂无白话对照'); return; }
      const wasReading = READ.on;
      stopRead();     // 切换原文/白话/对照 → 可见段落变了，句 Range 作废
      prefs.mode = b.dataset.m;
      store.set('mode', prefs.mode);
      reader.querySelector('.art-body').dataset.mode = prefs.mode;
      reader.querySelectorAll('.mode-bar .seg').forEach((x) =>
        x.classList.toggle('on', x === b));
      measureMax(); paintProgress();   // 可见段落变了，总高随之变 → 刷新高度缓存与进度条
      if (wasReading) startRead();     // 听着切层 → 换层后从当前位置接着读（读你所看）
    };
  });
  // 选读篇目 → 跳转文钞原篇
  reader.querySelectorAll('.xd-link').forEach((b) => {
    b.onclick = () => { goArticle(b.dataset.id); };
  });
  // 注释词条弹卡
  reader.querySelectorAll('.term').forEach((b) => {
    b.onclick = () => {
      const n = allNotes.find((x) => x.key === b.dataset.note);
      if (n) openSheet(n);
    };
  });
  // 行内角标弹卡（按编号取首个匹配）
  reader.querySelectorAll('sup.note-ref').forEach((s) => {
    s.onclick = () => {
      const n = allNotes.find((x) => x.n === parseInt(s.dataset.n, 10));
      if (n) openSheet(n);
    };
  });
  reader.querySelectorAll('.art-nav button').forEach((b) => {
    b.onclick = () => { goArticle(b.dataset.id); };
  });
  // 双链跳转：出处（嘉言录→文钞）与反向链接（文钞→嘉言录）
  reader.querySelectorAll('.seg-src.linked, .backref').forEach((b) => {
    b.onclick = () => { goArticle(b.dataset.go); };
  });

  // 定位：搜索命中高亮首处 / 否则续读恢复。先按当前(回退)字体立即定位，长文不空等；
  // 再等网络字体换入后重算高度重定位，消除 display=swap 换字后落点漂移（仅当用户尚未接管滚动）。
  let anchorEl = null, restorePct = 0;
  if (pendingFind) {
    anchorEl = markInRoot(reader.querySelector('.reader-inner'), pendingFind);
    pendingFind = '';
  } else {
    const saved = progress[id];
    if (saved && saved.pct > 0.02) restorePct = saved.pct;
  }
  const anchor = () => {
    measureMax();
    if (anchorEl) anchorEl.scrollIntoView({ block: 'center' });
    else scrollTo(0, restorePct ? restorePct * maxScroll : 0);
  };
  anchor();
  if ((anchorEl || restorePct) && document.fonts && document.fonts.status !== 'loaded') {
    const anchoredY = scrollY;
    fontsReady().then(() => {
      // 篇未切走、且用户未手动滚动接管（阈值 4px）时才校正，避免把正在阅读的人拽回
      if (current && current.id === id && Math.abs(scrollY - anchoredY) < 4) { anchor(); paintProgress(); }
    });
  }

  lastRead = { id, title: art.title };
  store.set('lastRead', lastRead);
  highlightNav();
  // 沉浸阅读基准：以当前（可能是续读跳位后的）滚动位置为准，避免开篇即误藏顶栏
  lastNavY = scrollY;
  document.body.classList.remove('nav-hidden');
  paintProgress();
  // 朗读/收藏/Aa 键随本篇重挂（渲染在篇内工具行，不在顶栏）
  bookmarkBtn = reader.querySelector('.mb-bookmark');
  speakBtn = reader.querySelector('.mb-speak');
  if (bookmarkBtn) bookmarkBtn.onclick = toggleBookmark;
  if (speakBtn) speakBtn.onclick = () => { READ.on ? stopRead() : startRead(); };
  { const aa = reader.querySelector('.mb-aa'); if (aa) aa.onclick = openAaSheet; }
  syncBookmarkBtn();      // 反映本篇收藏态
  applyMarks();           // 铺本篇已存的划线
}

/* 阅读进度：顶部细线实时更新（rAF），localStorage 节流保存 */
const progressBar = $('#read-progress');
let scrollTimer = null, rafPending = false, lastNavY = 0, maxScroll = 0;
// 可滚动高度缓存：滚动时若每帧读 scrollHeight 会触发回流，故缓存之，只在渲染/字体换入/resize/存档时重算
function measureMax() { maxScroll = document.body.scrollHeight - innerHeight; return maxScroll; }
addEventListener('resize', measureMax, { passive: true });
// 网络字体（正文 Noto Serif SC，display=swap）就绪：换入后行高、总高变化，据此在渲染后重算高度并重定位
function fontsReady(timeout = 1500) {
  if (!document.fonts || !document.fonts.ready) return Promise.resolve();
  return Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, timeout))]);
}
function paintProgress() {
  rafPending = false;
  progressBar.style.width = (current && maxScroll > 200)
    ? Math.min(100, scrollY / maxScroll * 100) + '%' : '0';
  // 沉浸阅读：读文章时下滑藏顶栏、上滑或近顶唤出（阈值 8px 防抖）
  const y = scrollY;
  if (!current || y < 72) document.body.classList.remove('nav-hidden');
  else if (y > lastNavY + 8) document.body.classList.add('nav-hidden');
  else if (y < lastNavY - 8) document.body.classList.remove('nav-hidden');
  lastNavY = y;
}
addEventListener('scroll', () => {
  if (!rafPending) { rafPending = true; requestAnimationFrame(paintProgress); }
  if (!current || scrollTimer) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    measureMax();   // 顺带刷新高度缓存（含晚到的字体换入、图片等引起的高度变化）
    if (maxScroll > 200) {
      progress[current.id] = { pct: Math.min(1, scrollY / maxScroll), t: Date.now() };
      store.set('progress', progress);
    }
  }, 600);
}, { passive: true });

/* ---------- 注释弹卡 ---------- */
const sheet = $('#sheet'), sheetBd = $('#sheet-backdrop');
function openSheet(note) {
  if (window.__wcSelBarHide) window.__wcSelBarHide();   // 注释卡打开时收起选段条，底部浮层不叠压
  $('#sheet-body').innerHTML = `
    <h4>${note.term ? '【' + esc(note.term) + '】' : '注释'}<span class="note-n">本篇注释 [${note.n}]</span></h4>
    <p>${esc(note.text)}</p>`;
  sheet.hidden = false; sheetBd.hidden = false;
}
function closeSheet() { sheet.hidden = true; sheetBd.hidden = true; }
sheetBd.onclick = closeSheet;
sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };

/* ---------- 收藏（书签）：整篇加星，「我的」页列出 ---------- */
let bookmarkBtn = null;   // 篇内工具行里的收藏键，每次 renderArticle 重挂
const isBooked = (id) => !!bookmarks[id];
function syncBookmarkBtn() {
  if (!bookmarkBtn) return;
  const on = !!(current && isBooked(current.id));
  bookmarkBtn.classList.toggle('on', on);
  bookmarkBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  bookmarkBtn.setAttribute('aria-label', on ? '取消收藏' : '收藏本篇');
}
function toggleBookmark() {
  if (!current) return;
  const id = current.id;
  if (bookmarks[id]) { delete bookmarks[id]; toast('已取消收藏'); }
  else { bookmarks[id] = { t: current.title, v: current.volumeName || '', ts: Date.now() }; toast('已收藏 · 在「我的」页可查看'); }
  store.set('bookmarks', bookmarks);
  syncBookmarkBtn();
}
// 收藏列表（按收藏时间倒序），「我的」页用
function bookmarkList() {
  return Object.entries(bookmarks)
    .map(([id, m]) => ({ id, t: (m && m.t) || id, v: (m && m.v) || '', ts: (m && m.ts) || 0 }))
    .sort((a, b) => b.ts - a.ts);
}

/* ---------- 划线（用户高亮）：Highlight API 不改 DOM（保名相/角标），段落序号+字符偏移换字号不漂移 ---------- */
const MARK = (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') ? new Highlight() : null;
if (MARK) CSS.highlights.set('wc-mark', MARK);
// 本篇可划线段落（原文+白话，DOM 序）；隐藏态段落的 range 不绘制，故无需按模式过滤
function readableParas() { const ab = $('#reader .art-body'); return ab ? [...ab.querySelectorAll('.p-orig, .p-trans')] : []; }
// el 内第 target 个字符所在的 (文本节点, 节点内偏移)
function charPointInEl(el, target) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let n, acc = 0, last = null;
  while ((n = w.nextNode())) {
    const len = n.nodeValue.length;
    if (target <= acc + len) return [n, target - acc];
    acc += len; last = n;
  }
  return last ? [last, last.nodeValue.length] : null;
}
// 选区边界 (node,off) 在段落 el 内的字符偏移
function offsetIn(el, node, off) {
  const r = document.createRange(); r.selectNodeContents(el);
  try { r.setEnd(node, off); } catch { return 0; }
  return r.toString().length;
}
// 同段重叠划线合并
function mergeHls(arr) {
  const byP = new Map();
  for (const h of arr) { if (!byP.has(h.p)) byP.set(h.p, []); byP.get(h.p).push(h); }
  const out = [];
  for (const [p, list] of byP) {
    list.sort((a, b) => a.s - b.s);
    let cur = null;
    for (const h of list) {
      if (cur && h.s <= cur.e) cur.e = Math.max(cur.e, h.e);
      else { cur = { p, s: h.s, e: h.e, t: h.t }; out.push(cur); }
    }
  }
  return out.sort((a, b) => a.p - b.p || a.s - b.s);
}
// 铺当前篇的划线到 Highlight（零 DOM 改动）
function applyMarks() {
  if (!MARK || !current) return;
  MARK.clear();
  const paras = readableParas();
  for (const h of getHls(current.id)) {
    const el = paras[h.p]; if (!el) continue;
    const a = charPointInEl(el, h.s), b = charPointInEl(el, h.e);
    if (!a || !b) continue;
    const r = document.createRange();
    try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); MARK.add(r); } catch {}
  }
}
// 把选区存为划线（供 share.js 选区操作条调用）。range 可传入（点按钮时活动选区可能已被收起，故 share.js 传选段时克隆的 Range）；返回是否成功
function addHighlightFromSelection(range) {
  const sel = getSelection();
  const r = range || (sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null);
  if (!r || !current) return false;
  const paras = readableParas();
  const add = [];
  paras.forEach((el, p) => {
    if (!r.intersectsNode(el) || !el.textContent.trim()) return;
    const whole = document.createRange(); whole.selectNodeContents(el);
    const s = r.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 ? 0 : offsetIn(el, r.startContainer, r.startOffset);
    const e = r.compareBoundaryPoints(Range.END_TO_END, whole) >= 0 ? el.textContent.length : offsetIn(el, r.endContainer, r.endOffset);
    if (e > s) add.push({ p, s, e, t: el.textContent.slice(s, Math.min(e, s + 40)) });
  });
  if (!add.length) return false;
  setHls(current.id, mergeHls([...getHls(current.id), ...add]));
  applyMarks();
  try { sel.removeAllRanges(); } catch {}
  toast('已划线 · 在「我的」页可回看');
  return true;
}
// 清除本篇某条划线（据段序+起点定位），供「我的划线」列表删除用
function removeHighlight(id, p, s) {
  const arr = getHls(id).filter((h) => !(h.p === p && h.s === s));
  setHls(id, arr);
  if (current && current.id === id) applyMarks();
}
// 全部划线（跨篇，扫 wc.hl.* 键），首页「我的划线」用
function allHighlights() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('wc.hl.')) continue;
    const id = k.slice(6);
    let arr; try { arr = JSON.parse(localStorage.getItem(k)) || []; } catch { continue; }
    if (!arr.length) continue;
    const fi = flat.find((x) => x.id === id);
    const title = (bookmarks[id] && bookmarks[id].t) || (fi && fi.title) || id;
    for (const h of arr) out.push({ id, p: h.p, s: h.s, t: h.t || '', title });
  }
  return out;
}
// 供 share.js 选区操作条调用：划词 → 划线（「问文钞」入口已按用户决定从选段条移除）
window.__wcHighlight = addHighlightFromSelection;
// 供 share.js 选段条「朗读」键调用：先还原克隆的选区（点按钮时活动选区可能已收起），
// 起点定位/清选区/「从选中处开始朗读」提示全部复用 startRead 现成逻辑
window.__wcReadFrom = (range) => {
  if (range) { try { const s = getSelection(); s.removeAllRanges(); s.addRange(range); } catch {} }
  startRead();
};

/* ---------- 正文朗读 / 跟读高亮 ----------
   speechSynthesis 逐句朗读当前可见正文（随阅读模式：原文 / 白话 / 对照）；
   当前句以 Custom Highlight API 高亮（不改 DOM，保留名相·角标可点），并自动滚动跟随。
   暂停=取消当前句、恢复=从本句重读（比 pause/resume 在安卓上更稳）。 */
let speakBtn = null;   // 篇内工具行里的朗读键，每次 renderArticle 重挂
const synthOK = () => 'speechSynthesis' in window;
const READ = {
  units: [], idx: 0, on: false, paused: false, cur: null, bar: null, seq: 0,
  rate: store.get('ttsRate', 0.95),
  voice: store.get('ttsVoice', 'charles'),    // 「声音」四选一：charles/david/anna=高清，local=本机嗓音（音质概念并入声音）
  sleep: 'off', sleepAt: 0,                   // 定时：off | 15 | 30 | 'chapter'（会话内，不持久化）
  degraded: false,                            // 高清故障临时降级本机；换声音/重开朗读时重试高清
};
// 读哪层不再单设开关（旧 ttsLayer/ttsAuto 键弃用）：「读你所看」——正文停在原文读原文，
// 白话/对照读白话；连播恒开，「只听这一篇」由定时「读完本篇」承担。
// 旧「音质=本机」偏好迁移为 声音=本机嗓音
if (store.get('ttsEngine') === 'local' && READ.voice !== 'local') READ.voice = 'local';
const useCloud = () => !READ.degraded && READ.voice !== 'local';
// 高清朗读端点（同 AI 代理：POST { text, layer, voice } → 音频字节；命中 R2 秒回）
const TTS_ENDPOINT = (CFG.aiEndpoint || '/api/ai').replace(/\/$/, '') + '/tts';
const TTS_VOICES = [   // 三种高清 + 本机嗓音（离线本机合成），默认第一个；chip=面板短标签
  { id: 'charles', name: '清亮男声', chip: '清亮' },
  { id: 'david', name: '沉稳男声', chip: '沉稳' },
  { id: 'anna', name: '柔和女声', chip: '柔和' },
  { id: 'local', name: '本机嗓音', chip: '本机' },
];
let _audio = null;                              // 高清引擎共用的 <audio>
function ensureAudio() { if (!_audio) { _audio = new Audio(); _audio.preload = 'auto'; } return _audio; }
// 本句是否仍「当前」：异步(高清 fetch / 音频)回调据此判断，避免切走后误推进
function isCurrent(token) { return READ.on && !READ.paused && READ.cur === token; }
function stopCur() {
  READ.cur = null; setLoading(false);
  if (synthOK()) window.speechSynthesis.cancel();
  if (_audio) { _audio.pause(); _audio.onended = _audio.onerror = null; }
}
// 句间预取：播当前句时顺手取下一句，命中 R2 秒回 → 消除句间空档
const _pf = new Map();   // idx -> Promise<objectURL>
function fetchUnitAudio(i) {
  if (_pf.has(i)) return _pf.get(i);
  const u = READ.units[i];
  if (!u) return Promise.reject(new Error('no unit'));
  const layer = u.el.classList.contains('p-orig') ? 'o' : 't';
  const p = fetch(TTS_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: u.text, layer, voice: READ.voice, a: current && current.id }),
  }).then((res) => { if (!res.ok) throw new Error('tts ' + res.status); return res.blob(); })
    .then((blob) => URL.createObjectURL(blob));
  _pf.set(i, p);
  return p;
}
function revokePf(p) { Promise.resolve(p).then((u) => { try { URL.revokeObjectURL(u); } catch {} }, () => {}); }
function clearPrefetch() { for (const p of _pf.values()) revokePf(p); _pf.clear(); }
function prunePrefetch(keep) { for (const [i, p] of [..._pf]) if (!keep.includes(i)) { revokePf(p); _pf.delete(i); } }
function setLoading(on) { if (READ.bar) READ.bar[on ? 'setAttribute' : 'removeAttribute']('data-loading', ''); }
let _fbNoted = false;                            // 本次朗读是否已提示过「降级本机」
function noteFallback() { if (_fbNoted) return; _fbNoted = true; toast('高清朗读暂不可用，已切到本机朗读'); }
function toast(msg) {
  let t = document.getElementById('wc-toast');
  if (!t) { t = document.createElement('div'); t.id = 'wc-toast'; t.className = 'wc-toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2400);
}
// 优先用 Custom Highlight API（句级、零 DOM 改动）；不支持则退化为 .reading-para 段级高亮
const HL = (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') ? new Highlight() : null;
if (HL) CSS.highlights.set('wc-read', HL);
const RB_ICON = {
  play: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 6h2v12H7zM20 6 11 12l9 6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15 6h2v12h-2zM4 6l9 6-9 6z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2.1"/><circle cx="9" cy="16" r="2.1"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

// 中文嗓音：列表常异步加载，voiceschanged 后重选
let _voice = null, _voiceTried = false;
function pickVoice() {
  if (_voice || _voiceTried) return _voice;
  const vs = window.speechSynthesis.getVoices() || [];
  _voice = vs.find((x) => /zh|chinese|中文|普通话|han/i.test((x.lang || '') + (x.name || ''))) || null;
  if (vs.length) _voiceTried = true;
  return _voice;
}
if (synthOK()) window.speechSynthesis.onvoiceschanged = () => { _voice = null; _voiceTried = false; pickVoice(); };

// 把当前可见正文切成「句」单元，并为每句留一个可高亮的 DOM Range（跨行内子节点安全）
function buildUnits(layer) {
  const sel = layer === 'o' ? '.art-body .p-orig' : '.art-body .p-trans';   // 单层朗读，不做文白交替
  const els = [...$('#reader').querySelectorAll('.art-title, ' + sel)]
    .filter((el) => el.offsetParent !== null);
  const END = '。！？!?…', CLOSE = '」』）)】》”’';
  const units = [];
  for (const el of els) {
    const map = []; let s = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && !(n.parentElement && n.parentElement.closest('sup.note-ref')))
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let n; while ((n = w.nextNode())) { const v = n.nodeValue; for (let i = 0; i < v.length; i++) { map.push([n, i]); s += v[i]; } }
    const push = (a, b) => {
      let ai = a; while (ai < b && /\s/.test(s[ai])) ai++;
      let bi = b - 1; while (bi > ai && /\s/.test(s[bi])) bi--;
      if (bi < ai) return;
      const text = s.slice(ai, bi + 1);
      if (!/[一-鿿A-Za-z0-9]/.test(text)) return;   // 纯标点/空白：跳过
      const r = document.createRange();
      r.setStart(map[ai][0], map[ai][1]);
      r.setEnd(map[bi][0], map[bi][1] + 1);
      units.push({ el, text, range: r });
    };
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\n') { push(start, i); start = i + 1; continue; }
      if (END.indexOf(s[i]) >= 0) {                 // 句末标点连同其后的收尾引号/括号归本句
        let j = i + 1; while (j < s.length && CLOSE.indexOf(s[j]) >= 0) j++;
        push(start, j); i = j - 1; start = j;
      }
    }
    push(start, s.length);
  }
  return units;
}

function clearHL() {
  document.querySelectorAll('.reading-para').forEach((e) => e.classList.remove('reading-para'));
  if (HL) HL.clear();
}
function markUnit(u) {
  document.querySelectorAll('.reading-para').forEach((e) => e.classList.remove('reading-para'));
  u.el.classList.add('reading-para');
  if (HL) { HL.clear(); HL.add(u.range); }
}
function scrollUnit(u) {
  const r = u.range.getBoundingClientRect();
  if (!r.height && !r.width) return;
  const top = ($('#topbar') ? $('#topbar').offsetHeight : 52) + 10;
  if (r.top < top || r.bottom > innerHeight - 110)
    scrollTo({ top: Math.max(0, scrollY + r.top - innerHeight * 0.32), behavior: 'smooth' });
}

function ensureReadBar() {
  if (READ.bar) return READ.bar;
  const bar = document.createElement('div');
  bar.className = 'read-bar'; bar.hidden = true;
  // 一行「标签 + chip 单选组」：所有选项一眼可见、一点即选，不做循环盲切
  const chips = (key, opts) =>
    `<div class="rb-set"><span class="rb-set-k">${key === 'voice' ? '声音' : key === 'rate' ? '语速' : '定时'}</span>` +
    `<span class="rb-chips">` +
    opts.map(([v, label, full]) =>
      `<button class="rb-chip rb-c-${key}" type="button" data-v="${v}"${full ? ` aria-label="${full}"` : ''}>${label}</button>`).join('') +
    `</span></div>`;
  bar.innerHTML =
    // 极简：主行恒为单行 transport；设置只剩 声音/语速/定时 三行，收进上浮面板（不撑高主条）
    `<div class="rb-panel" hidden>` +
      chips('voice', TTS_VOICES.map((v) => [v.id, v.chip, v.name])) +
      chips('rate', [['0.75', '慢'], ['0.95', '常'], ['1.2', '快']]) +
      chips('sleep', [['off', '不停'], ['chapter', '读完本篇'], ['15', '15分'], ['30', '30分']]) +
    `</div>` +
    `<div class="rb-row">` +
      `<button class="rb-btn rb-prev" type="button" aria-label="上一句">${RB_ICON.prev}</button>` +
      `<button class="rb-btn rb-play" type="button" aria-label="暂停">${RB_ICON.pause}</button>` +
      `<button class="rb-btn rb-next" type="button" aria-label="下一句">${RB_ICON.next}</button>` +
      `<span class="rb-sep" aria-hidden="true"></span>` +
      `<button class="rb-btn rb-more" type="button" aria-label="朗读设置">${RB_ICON.more}</button>` +
      `<button class="rb-btn rb-x" type="button" aria-label="结束朗读">${RB_ICON.close}</button>` +
    `</div>`;
  document.body.appendChild(bar);
  bar.querySelector('.rb-prev').onclick = () => jumpRead(-1);
  bar.querySelector('.rb-next').onclick = () => jumpRead(1);
  bar.querySelector('.rb-play').onclick = togglePause;
  bar.querySelectorAll('.rb-c-voice').forEach((c) => { c.onclick = () => setVoice(c.dataset.v); });
  bar.querySelectorAll('.rb-c-rate').forEach((c) => { c.onclick = () => setRate(+c.dataset.v); });
  bar.querySelectorAll('.rb-c-sleep').forEach((c) => {
    c.onclick = () => setSleep(/^\d+$/.test(c.dataset.v) ? +c.dataset.v : c.dataset.v);
  });
  bar.querySelector('.rb-more').onclick = (e) => { const p = bar.querySelector('.rb-panel'); p.hidden = !p.hidden; e.currentTarget.classList.toggle('on', !p.hidden); };
  // 点面板与条以外任意处 → 收起设置面板（朗读继续）
  document.addEventListener('pointerdown', (e) => {
    const p = bar.querySelector('.rb-panel');
    if (p.hidden || bar.contains(e.target)) return;
    p.hidden = true; bar.querySelector('.rb-more').classList.remove('on');
  });
  // 手动关闭＝结束本次收听：定时一并清零
  bar.querySelector('.rb-x').onclick = () => { READ.sleep = 'off'; READ.sleepAt = 0; stopRead(); };
  READ.bar = bar;
  return bar;
}
function syncBar() {
  if (!READ.bar) return;
  const play = READ.bar.querySelector('.rb-play');
  play.innerHTML = READ.paused ? RB_ICON.play : RB_ICON.pause;
  play.setAttribute('aria-label', READ.paused ? '继续朗读' : '暂停');
  const mark = (cls, val) => READ.bar.querySelectorAll('.' + cls).forEach((c) =>
    c.classList.toggle('on', c.dataset.v === String(val)));
  mark('rb-c-voice', READ.voice);
  mark('rb-c-rate', READ.rate);
  mark('rb-c-sleep', READ.sleep);
}

// 读你所看：正文停在原文读原文；白话/对照读白话；无白话篇只能原文。不改动页面显示。
function readLayer() {
  const ab = $('#reader .art-body');
  if (!ab || !ab.querySelector('.p-trans')) return 'o';
  return ab.dataset.mode === 'orig' ? 'o' : 't';
}

function speakIdx(i) {
  if (i < 0) i = 0;
  if (READ.sleepAt && Date.now() >= READ.sleepAt) {     // 睡眠定时到点：句间自然收声
    READ.sleep = 'off'; READ.sleepAt = 0;
    stopRead(); toast('睡眠定时到，朗读结束');
    return;
  }
  if (i >= READ.units.length) { endOfArticle(); return; }   // 读完本篇：连播或结束
  READ.idx = i;
  const u = READ.units[i];
  markUnit(u); scrollUnit(u);
  const token = ++READ.seq;
  READ.cur = token;
  if (useCloud()) playCloud(i, token);
  else playLocal(u, token);
}
// 读完本篇：连播恒开，自动接读下一篇；定时设「读完本篇」或已是最后一篇则到此止
function endOfArticle() {
  const i = current ? flat.findIndex((it) => it.id === current.id) : -1;
  const next = i >= 0 && i < flat.length - 1 ? flat[i + 1] : null;
  if (READ.sleep === 'chapter' || !next) {
    const chapterEnd = READ.sleep === 'chapter';
    READ.sleep = 'off'; READ.sleepAt = 0;
    stopRead();
    if (chapterEnd) toast('本篇读毕，朗读结束');
    return;
  }
  autoNext(next);
}
async function autoNext(next) {
  toast('续播 · ' + next.title);
  history.pushState(null, '', articleHref(next.id));
  await route();        // route 会停掉本篇朗读并渲染下一篇
  scrollTo(0, 0);       // 连播从篇首读起，不受该篇旧续读位置影响
  startRead();
}
// 本机引擎：speechSynthesis 逐句合成（免费·离线可用）
function playLocal(u, token) {
  if (!synthOK()) { toast('本设备不支持本机朗读'); stopRead(); return; }
  const utt = new SpeechSynthesisUtterance(localPron(u.text));
  utt.lang = 'zh-CN'; utt.rate = READ.rate;
  const v = pickVoice(); if (v) utt.voice = v;
  utt.onend = () => { if (isCurrent(token)) speakIdx(READ.idx + 1); };
  utt.onerror = () => { if (isCurrent(token)) speakIdx(READ.idx + 1); };
  try { window.speechSynthesis.speak(utt); } catch {}
}
// 高清引擎：优先用预取好的音频 → <audio> 播放，同时预取下一句以消除句间停顿；失败自动降级本机
async function playCloud(i, token) {
  const u = READ.units[i];
  const a = ensureAudio();
  prunePrefetch([i, i + 1]);            // 回收更早的音频，控内存
  let url;
  setLoading(true);
  try { url = await fetchUnitAudio(i); }
  catch (e) {
    setLoading(false);
    if (!isCurrent(token)) return;
    noteFallback(); READ.degraded = true; playLocal(u, token);   // 本次朗读临时降级本机并续读本句
    return;
  }
  setLoading(false);
  if (!isCurrent(token)) return;         // 期间被切走/暂停/停止 → 丢弃
  a.src = url; a.playbackRate = READ.rate;
  a.onended = () => { if (isCurrent(token)) speakIdx(READ.idx + 1); };
  a.onerror = () => { if (isCurrent(token)) { noteFallback(); READ.degraded = true; playLocal(u, token); } };
  a.play().catch(() => {});
  if (i + 1 < READ.units.length) fetchUnitAudio(i + 1).catch(() => {});   // 预取下一句
}

// 朗读起点：不再一律从篇首。优先「从选中处」，其次「从当前视口顶部当前句」，都没有才篇首。
// 因文章重开会自动滚回上次进度（loadArticle 恢复 pct），故此逻辑天然实现「续读」。
function readStartIndex() {
  const units = READ.units;
  if (!units.length) return 0;
  const ab = $('#reader .art-body');
  // 1) 有选区且落在正文内 → 从选区顶端所在（或其后第一）句起
  const sel = getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed && ab && ab.contains(sel.anchorNode)) {
    const y = sel.getRangeAt(0).getBoundingClientRect().top;
    const i = units.findIndex((u) => { const r = u.range.getBoundingClientRect(); return r.height && r.bottom > y - 1; });
    if (i >= 0) return i;
  }
  // 2) 从当前视口顶部（顶栏之下）第一句起
  const top = ($('#topbar') ? $('#topbar').offsetHeight : 52) + 8;
  const i = units.findIndex((u) => { const r = u.range.getBoundingClientRect(); return r.height && r.bottom > top; });
  return i >= 0 ? i : 0;
}
function startRead() {
  if (!current) return;
  if (READ.sleepAt && Date.now() >= READ.sleepAt) { READ.sleep = 'off'; READ.sleepAt = 0; }   // 过期定时清零，防重开即停
  READ.units = buildUnits(readLayer());   // 读你所看：不切换页面显示
  if (!READ.units.length) return;
  // 起点提示：让「选中即从此处读」「滚到哪读到哪」这两个能力被看见
  const ab = $('#reader .art-body');
  const s0 = getSelection();
  const hadSel = !!(s0 && s0.rangeCount && !s0.isCollapsed && ab && ab.contains(s0.anchorNode));
  const from = readStartIndex();      // 先定起点（要用到当前选区/滚动位置）
  const s = getSelection(); if (s) s.removeAllRanges();   // 用过选区即收起，避免与朗读高亮/选段条打架
  stopCur(); _fbNoted = false; READ.degraded = false;     // 每次开读重试高清
  READ.on = true; READ.paused = false;
  if (speakBtn) speakBtn.classList.add('on');
  ensureReadBar().hidden = false;
  syncBar();
  setupMediaSession(); syncMediaState();
  if (from > 0) toast(hadSel ? '从选中处开始朗读' : '从当前位置开始朗读');
  speakIdx(from);
}
function stopRead() {
  stopCur(); clearPrefetch();
  READ.on = false; READ.paused = false; READ.units = [];
  if (_audio) _audio.removeAttribute('src');
  clearHL();
  if (speakBtn) speakBtn.classList.remove('on');
  if (READ.bar) { READ.bar.hidden = true; const p = READ.bar.querySelector('.rb-panel'); if (p) p.hidden = true; const m = READ.bar.querySelector('.rb-more'); if (m) m.classList.remove('on'); }
  syncMediaState();
}
/* 锁屏/耳机媒体控制（MediaSession）：高清朗读经 <audio> 播放，锁屏可见篇名封面、可控播停切句 */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: (current && current.title) || '印光法师文钞',
      artist: '印光法师文钞',
      album: (current && current.volumeName) || '文白对照',
      artwork: [
        { src: '/img/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      ],
    });
    navigator.mediaSession.setActionHandler('play', () => { if (READ.on && READ.paused) togglePause(); });
    navigator.mediaSession.setActionHandler('pause', () => { if (READ.on && !READ.paused) togglePause(); });
    navigator.mediaSession.setActionHandler('stop', () => stopRead());
    navigator.mediaSession.setActionHandler('previoustrack', () => jumpRead(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => jumpRead(1));
  } catch {}
}
function syncMediaState() {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = READ.on ? (READ.paused ? 'paused' : 'playing') : 'none'; } catch {}
}
function togglePause() {
  if (!READ.on) return;
  if (READ.paused) {
    READ.paused = false; syncBar(); syncMediaState();
    // 高清：音频未播完则原地续播；否则（本机/已播完/尚未取到）从本句重来
    if (useCloud() && _audio && _audio.src && _audio.duration && _audio.currentTime < _audio.duration) {
      _audio.play().catch(() => speakIdx(READ.idx));
    } else { speakIdx(READ.idx); }
  } else {
    READ.paused = true;
    if (useCloud()) { if (_audio) _audio.pause(); }
    else if (synthOK()) window.speechSynthesis.cancel();
    syncBar(); syncMediaState();
  }
}
function jumpRead(d) {
  if (!READ.on) return;
  READ.paused = false; stopCur();
  syncBar(); speakIdx(READ.idx + d);
}
function setRate(r) {
  if (READ.rate === r) return;
  READ.rate = r;
  store.set('ttsRate', READ.rate);
  syncBar();
  if (READ.on && !READ.paused) {
    if (useCloud() && _audio && _audio.src) _audio.playbackRate = READ.rate;  // 高清即时变速，无需重读
    else { stopCur(); speakIdx(READ.idx); }
  }
}
function setVoice(id) {
  if (READ.voice === id) return;
  READ.voice = id;
  store.set('ttsVoice', READ.voice);
  READ.degraded = false; _fbNoted = false;   // 换声音重试高清
  clearPrefetch();                           // 声音变了，预取作废
  syncBar();
  if (READ.on && !READ.paused) { stopCur(); speakIdx(READ.idx); }
}
function setSleep(v) {
  if (READ.sleep === v) return;
  READ.sleep = v;
  READ.sleepAt = typeof v === 'number' ? Date.now() + v * 60000 : 0;
  syncBar();
  toast(v === 'off' ? '定时已关'
    : v === 'chapter' ? '读完本篇自动停止'
    : v + ' 分钟后自动停止');
}

/* ---------- 偏好控件 ---------- */
// 调字号后正文重排、总高变化 → 刷新高度缓存与进度条（续读落点不动，仅让进度条即时准确）
const afterFontChange = () => { applyPrefs(); measureMax(); paintProgress(); };
const incFont = () => { prefs.fs = Math.min(24, prefs.fs + 1); store.set('fs', prefs.fs); afterFontChange(); };
const decFont = () => { prefs.fs = Math.max(14, prefs.fs - 1); store.set('fs', prefs.fs); afterFontChange(); };
const setTheme = (name) => { prefs.theme = name; store.set('theme', name); applyPrefs(); };

/* ---------- 阅读设置 sheet（工具行「Aa」打开）----------
   字号/底色/简繁集中于此，正文就在 sheet 后面，改动所见即所得；
   形制同注释弹卡，行样式与播放器面板同一套 chip 语言。 */
let aaSheet = null;
function ensureAaSheet() {
  if (aaSheet) return aaSheet;
  const el = document.createElement('div');
  el.className = 'aa-sheet'; el.hidden = true;
  el.innerHTML =
    `<div class="aa-mask"></div>` +
    `<div class="aa-panel">` +
      `<div class="rb-set"><span class="rb-set-k">字号</span><span class="rb-chips">` +
        `<button class="rb-chip" id="font-dec" type="button" aria-label="减小字号">A−</button>` +
        `<span class="aa-fs" aria-live="polite"></span>` +
        `<button class="rb-chip" id="font-inc" type="button" aria-label="增大字号">A＋</button></span></div>` +
      `<div class="rb-set"><span class="rb-set-k">底色</span><span class="rb-chips">` +
        `<button class="rb-chip" id="theme-paper" type="button">纸色</button>` +
        `<button class="rb-chip" id="theme-plain" type="button">素白</button>` +
        `<button class="rb-chip" id="theme-night" type="button">墨夜</button></span></div>` +
      `<div class="rb-set"><span class="rb-set-k">文字</span><span class="rb-chips">` +
        `<button class="rb-chip" id="cc-simp" type="button">简体</button>` +
        `<button class="rb-chip" id="cc-trad" type="button">繁体</button></span></div>` +
    `</div>`;
  document.body.appendChild(el);
  el.querySelector('.aa-mask').onclick = closeAaSheet;
  el.querySelector('#font-dec').onclick = () => { decFont(); syncAaSheet(); };
  el.querySelector('#font-inc').onclick = () => { incFont(); syncAaSheet(); };
  el.querySelector('#theme-paper').onclick = () => setTheme('paper');
  el.querySelector('#theme-plain').onclick = () => setTheme('plain');
  el.querySelector('#theme-night').onclick = () => setTheme('night');
  el.querySelector('#cc-simp').onclick = () => setTrad(false);
  el.querySelector('#cc-trad').onclick = () => setTrad(true);
  aaSheet = el;
  return el;
}
function syncAaSheet() {
  if (!aaSheet) return;
  aaSheet.querySelector('.aa-fs').textContent = prefs.fs;
  applyPrefs();   // 同步 #theme-* / #cc-* 的选中态（applyPrefs 按需寻元素，安全）
}
function openAaSheet() {
  if (window.__wcSelBarHide) window.__wcSelBarHide();   // 底部浮层不叠压
  ensureAaSheet().hidden = false;
  syncAaSheet();
}
function closeAaSheet() { if (aaSheet) aaSheet.hidden = true; }

/* ---------- 简繁转换（OpenCC 自托管，懒加载；仅显示层，不改底本数据）---------- */
let _conv = null;
function loadOpenCC() {
  if (_conv) return Promise.resolve(_conv);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/js/opencc.js?v=20260616-ai-v2';
    s.onload = () => {
      try {
        const c = OpenCC.Converter({ from: 'cn', to: 'tw' });
        _conv = (t) => c(t).replace(/唸/g, '念');   // 佛教保留"念佛"，不作"唸"
      } catch (e) { _conv = (t) => t; }
      resolve(_conv);
    };
    s.onerror = () => { _conv = (t) => t; resolve(_conv); };
    document.head.appendChild(s);
  });
}
function tradify(root) {                 // 把元素内文本节点 简→繁（不碰标签/属性）
  if (!_conv || !root) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && /[一-鿿]/.test(n.nodeValue)
      && !(n.parentNode && /^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)))
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const ns = []; let n; while ((n = w.nextNode())) ns.push(n);
  ns.forEach((t) => { t.nodeValue = _conv(t.nodeValue); });
}
function maybeTradify(el) { if (prefs.trad && _conv && el) tradify(el); }
function setTrad(on) {
  stopRead();     // 简繁切换会改写文本节点，正读着的 Range 会失效 → 先停
  prefs.trad = on; store.set('trad', on); applyPrefs();
  if (on) {
    loadOpenCC().then(() => { tradify($('#reader')); tradify($('#nav-tree')); tradify($('#ai-log')); });
  } else {
    route(); renderTree($('#nav-search').value);   // 从简体源重渲染（无损还原）
  }
}

/* ---------- AI 助读 ---------- */
const aiLog = $('#ai-log');
const aiHistory = [];                       // 发给后端的上下文（{role,content}）
let aiSession = store.get('aiSession', []);  // 持久化的可渲染会话：u={r,c} / b={r,c,p:passages,q,v}
// 给一段已渲染的回答绑定行内角标 [n] 的点击/悬停（点开出处弹卡）；多处渲染共用
function wireCites(div, passages) {
  div.querySelectorAll('.ai-cite').forEach((b) => {
    const p = passages && passages[+b.dataset.n - 1];
    b.onclick = () => showCitation(p);
    citeHover(b, p);
  });
}
function aiAppend(role, text, passages) {
  const div = document.createElement('div');
  div.className = 'ai-msg ' + (role === 'user' ? 'user' : 'bot');
  if (role === 'user') {
    div.textContent = text;
  } else {
    div.innerHTML = aiFormat(text, passages);
    wireCites(div, passages);
  }
  aiLog.appendChild(div);
  aiLog.scrollTop = aiLog.scrollHeight;
  return div;
}
// aiFormat（轻量 Markdown + 角标）与 citationExcerpt（出处摘录）已移至共享内核 ai-core.js，
// 供抽屉与独立页 /ask/ 共用（顶部 import）。
// 点角标 → 底部弹卡显示出处原文 + 阅读原文（统一只显原文，白话在「阅读原文」里）
function showCitation(p) {
  if (!p) return;
  const excerpt = citationExcerpt(p);
  const url = p.url || (p.aid ? articleHref(p.aid, p.pIndex) : '');
  $('#sheet-body').innerHTML =
    `<h4>《${esc(p.title || '')}》<span class="note-n">出处摘录</span></h4>` +
    `<p class="cite-text">${esc(excerpt)}</p>` +
    (p.aid ? `<button class="sheet-goto" data-id="${esc(p.aid)}" data-p="${p.pIndex ?? ''}" data-url="${esc(url)}">阅读原文 ›</button>` : '');
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  const g = $('#sheet-body .sheet-goto');
  if (g) g.onclick = () => {
    $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true;
    if (g.dataset.url) {
      const u = new URL(g.dataset.url, location.origin);
      history.pushState(null, '', u.pathname + u.search);
      route();
    } else {
      goArticle(g.dataset.id, g.dataset.p);
    }
    closeDrawers();
  };
}
// 角标 hover 预览（citeHover）已移至共享内核 ai-core.js，抽屉与 /ask/ 共用。
// 首次进入的欢迎引导语（仅展示，不计入对话历史）——简明传达「什么都可以问，依文钞作答」
function aiWelcome() {
  if (aiLog.children.length) return;
  const div = document.createElement('div');
  div.className = 'ai-welcome';
  div.innerHTML =
    '<p class="aw-greet">南无阿弥陀佛</p>' +
    '<p class="aw-lead">心有所惑，皆可来问。</p>' +
    '<p>无论念佛、信愿、因果、家庭，还是病苦、临终大事，我都会依《印光法师文钞》原文为您解答，并附出处可查。</p>' +
    '<p class="aw-hint">点上方常见问题，或在下方直接问。</p>';
  aiLog.appendChild(div);
}
// 会话留存：刷新/重开不丢最近问答（最多 30 条记录，约 15 轮）
function saveSession() { try { store.set('aiSession', aiSession.slice(-30)); } catch {} }
// 静态渲染一条已存的回答（含可点出处与操作条），供恢复会话复用
function renderBot(rec) {
  const div = document.createElement('div');
  div.className = 'ai-msg bot';
  div.innerHTML = aiFormat(rec.c, rec.p);
  maybeTradify(div);
  wireCites(div, rec.p);
  aiLog.appendChild(div);
  appendVerify(div, rec.v);
  aiFeedback(div, rec.q, rec.c, rec.p);
  return div;
}
// 启动：有留存会话则恢复（含上下文与可点出处），否则显示欢迎语
function aiInit() {
  if (aiSession.length) {
    aiHistory.length = 0;
    aiSession.forEach((rec) => {
      if (rec.r === 'u') { aiAppend('user', rec.c); aiHistory.push({ role: 'user', content: rec.c }); }
      else { renderBot(rec); aiHistory.push({ role: 'assistant', content: rec.c }); }
    });
    aiLog.scrollTop = aiLog.scrollHeight;
  } else {
    aiWelcome();
  }
}
let aiAbort = null;
const aiSendBtn = () => $('.ai-send');
async function aiAsk(q) {
  aiAppend('user', q);
  aiHistory.push({ role: 'user', content: q });
  if (!CFG.aiEndpoint) {
    aiAppend('bot',
      'AI 服务尚未接入。配置 config.js 的 aiEndpoint（指向 Cloudflare Worker 知识库代理）后，即可就印光法师文钞全集提问。');
    return;
  }
  const placeholder = document.createElement('div');
  placeholder.className = 'ai-msg bot ai-loading';
  placeholder.innerHTML = '<i>正在查阅文钞</i><span></span><span></span><span></span>';
  aiLog.appendChild(placeholder);
  aiLog.scrollTop = aiLog.scrollHeight;

  let passages = null, full = '', div = null, lastPaint = 0, verify = null;
  const ensureDiv = () => {
    if (!div) {
      if (placeholder.parentNode) placeholder.remove();
      div = document.createElement('div'); div.className = 'ai-msg bot';
      aiLog.appendChild(div);
    }
    return div;
  };
  const paint = () => {                       // 边流式边排版（Markdown + 角标）
    const d = ensureDiv();
    d.innerHTML = aiFormat(full, passages);
    maybeTradify(d);
    wireCites(d, passages);
    aiLog.scrollTop = aiLog.scrollHeight;
  };
  const onMsg = (m) => {
    if (!m) return;
    if (m.type === 'meta') passages = m.passages;
    else if (m.type === 'delta') {
      full += m.text || '';
      const t = Date.now();
      if (t - lastPaint > 120) { lastPaint = t; paint(); }   // 节流，避免每字重排
    } else if (m.type === 'done') {
      verify = m.verify || null;   // 引用逐字自检信号，供渲染核验徽标
    } else if (typeof m.reply === 'string' && m.reply) {
      full += m.reply;   // 错误/限流等返回 {reply:'…'}（无 type），照样显示给用户而非吞成"无回复"
    }
  };

  aiAbort = new AbortController();
  const sb = aiSendBtn(); if (sb) sb.textContent = '停止';
  let failed = false;
  try {
    const payload = { messages: aiHistory.slice(-8) };
    if (current && current.id) payload.articleId = current.id;
    const res = await fetch(CFG.aiEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: aiAbort.signal,
    });
    if (res.body && res.body.getReader) {          // 流式（打字机）
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line) try { onMsg(JSON.parse(line)); } catch { /* 半行 */ }
        }
      }
      if (buf.trim()) { try { onMsg(JSON.parse(buf.trim())); } catch { /* 末行：无换行的 {reply} 错误体也要收尾解析 */ } }
    } else {                                        // 不支持流式：整体读取
      (await res.text()).split('\n').forEach((l) => { if (l.trim()) try { onMsg(JSON.parse(l)); } catch {} });
    }
  } catch (err) {
    if (!(err && err.name === 'AbortError')) {     // 非"停止"才算失败
      failed = true;
      if (placeholder.parentNode) placeholder.remove();
      aiAppend('bot', '请求失败，请稍后重试。');
    }
  } finally {
    aiAbort = null;
    const b = aiSendBtn(); if (b) b.textContent = '发送';
  }
  if (failed) return;
  if (placeholder.parentNode) placeholder.remove();
  if (!full) full = '（无回复）';
  paint();   // 收尾：完整排版（"停止"则保留已生成部分）
  aiHistory.push({ role: 'assistant', content: full });
  if (full !== '（无回复）') {
    appendVerify(ensureDiv(), verify);
    aiFeedback(ensureDiv(), q, full, passages);
    aiSession.push({ r: 'u', c: q });
    aiSession.push({ r: 'b', c: full, p: passages || [], q, v: verify });
    saveSession();
  }
}
// appendVerify（核验徽标落地）、copyText/execCopy（复制）、FB_ICON（图标集）已移至共享内核 ai-core.js。
// 把一问一答制成可转发的图（复用 share.js 的卡片/二维码/系统分享）
function aiShare(question, reply, passages) {
  if (!(window.WenchaoShare && window.WenchaoShare.aiCard)) { copyText(reply); return; }
  // 仅去引用角标与加粗符；保留小标题/序号/要点，供分享卡按结构排版
  const body = (reply || '')
    .replace(/\[\d{1,2}\]/g, '').replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  // 二维码直达独立 AI 页 /ask/；AI 问答卡见 share.js 的 drawAICard
  const base = (CFG.shareBase || location.origin).replace(/\/$/, '');
  window.WenchaoShare.aiCard(question, body, base + '/ask/');
}
// 朗读用纯文本 + 佛门读音替换（PRON/speakable）已并入共享内核 ai-core.js 的 localPron，阅读器与 AI 降级共用一张表。
// AI 回答朗读：高清(服务端 CosyVoice2) 优先、失败自动降级本机；逻辑集中在共享内核 aiSpeakToggle。
const aiSpeak = (reply, btn) => aiSpeakToggle(CFG.aiEndpoint || '/api/ai', reply, btn, { speak: FB_ICON.speak, stop: FB_ICON.stop });
function aiFeedback(el, question, reply, passages) {
  const bar = document.createElement('div');
  bar.className = 'ai-fb';
  bar.innerHTML =
    '<button class="ai-fb-btn ai-speak" type="button" title="朗读" aria-label="朗读">' + FB_ICON.speak + '</button>' +
    '<button class="ai-fb-btn ai-copy" type="button" title="复制回答" aria-label="复制回答">' + FB_ICON.copy + '</button>' +
    '<button class="ai-fb-btn ai-share" type="button" title="分享问答" aria-label="分享问答">' + FB_ICON.share + '</button>' +
    '<span class="ai-fb-gap"></span>' +
    '<button class="ai-fb-btn" data-v="up" type="button" title="有帮助" aria-label="有帮助">' + FB_ICON.up + '</button>' +
    '<button class="ai-fb-btn" data-v="down" type="button" title="需更正" aria-label="需更正">' + FB_ICON.down + '</button>';
  el.appendChild(bar);
  bar.querySelector('.ai-speak').onclick = function () { aiSpeak(reply, this); };
  bar.querySelector('.ai-share').onclick = function () { aiShare(question, reply, passages); };
  const cp = bar.querySelector('.ai-copy');
  cp.onclick = () => {
    copyText(reply);
    cp.classList.add('ok');
    cp.innerHTML = FB_ICON.check;
    cp.title = '已复制';
    setTimeout(() => {
      cp.classList.remove('ok');
      cp.innerHTML = FB_ICON.copy;
      cp.title = '复制回答';
    }, 1200);
  };
  bar.querySelectorAll('[data-v]').forEach((b) => {
    b.onclick = () => {
      fetch(CFG.aiEndpoint.replace(/\/$/, '') + '/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote: b.dataset.v, question, reply }),
      }).catch(() => {});
      bar.innerHTML = '<span>感谢您的反馈，南无阿弥陀佛。</span>';
    };
  });
}
const aiText = $('#ai-text');
$('#ai-form').onsubmit = (e) => {
  e.preventDefault();
  if (aiAbort) { aiAbort.abort(); return; }     // 生成中 → 停止
  const v = aiText.value.trim();
  if (!v) return;
  aiText.value = ''; aiText.style.height = 'auto';
  aiAsk(v);
};
aiText.addEventListener('keydown', (e) => {     // 回车发送；Shift+Enter 换行；输入法编辑中不发
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    if (aiText.value.trim() && !aiAbort) $('#ai-form').dispatchEvent(new Event('submit', { cancelable: true }));
  }
});
aiText.addEventListener('input', () => {        // 自适应高度
  aiText.style.height = 'auto';
  aiText.style.height = Math.min(aiText.scrollHeight, 120) + 'px';
});
document.querySelectorAll('#ai-chips .chip-btn').forEach((b) => {
  b.onclick = () => aiAsk(b.dataset.q);    // 全库问答，不绑当前篇
});
const aiNewBtn = $('#btn-ai-new');
if (aiNewBtn) aiNewBtn.onclick = () => {     // 新对话：清空重来（含留存）
  aiSpeakStop();
  if (aiAbort) aiAbort.abort();
  aiHistory.length = 0;
  aiSession.length = 0;
  saveSession();
  aiLog.innerHTML = '';
  aiWelcome();
};
aiInit();

/* ---------- 启动 ---------- */
async function boot() {
  applyPrefs();
  const syncWide = () => {
    if (isWide()) { document.body.dataset.wide = '1'; closeDrawers(); }
    else delete document.body.dataset.wide;
  };
  syncWide();
  matchMedia('(min-width: 1180px)').addEventListener('change', syncWide);
  try {
    books = await (await fetch('/data/books.json', { cache: 'no-cache' })).json();
  } catch {
    $('#reader').innerHTML = '<p class="loading">目录载入失败，请刷新重试</p>';
    return;
  }
  flat = [];
  for (const vol of books)
    for (const j of vol.juans)
      for (const c of j.cats)
        for (const it of c.items)
          flat.push({ ...it, volName: vol.name });
  $('#nav-stats').textContent = `${books.length} 部 · ${flat.length} 篇 · 文白对照`;
  renderTree();
  await route();
  if (prefs.trad) loadOpenCC().then(() => { tradify($('#reader')); tradify($('#nav-tree')); tradify($('#ai-log')); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot();
