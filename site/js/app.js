/* ===================================================================
   印光法师文钞 · 文白对照 阅读器
   纯前端、无构建：books.json 目录树 + articles/{id}.json 按篇懒加载
   =================================================================== */

import { aiFormat, citationExcerpt } from './ai-core.js';

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
  $('#theme-paper').classList.toggle('on', prefs.theme === 'paper');
  if ($('#theme-plain')) $('#theme-plain').classList.toggle('on', prefs.theme === 'plain');
  $('#theme-night').classList.toggle('on', prefs.theme === 'night');
  if ($('#cc-simp')) $('#cc-simp').classList.toggle('on', !prefs.trad);
  if ($('#cc-trad')) $('#cc-trad').classList.toggle('on', prefs.trad);
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
  if (window.speechSynthesis) window.speechSynthesis.cancel();   // 关面板即停朗读
}
$('#btn-nav').onclick = () => openDrawer('L');
$('#btn-ai').onclick = () => openDrawer('R');
$('#btn-ai-close').onclick = closeDrawers;
overlay.onclick = closeDrawers;
$('#topbar-title').onclick = () => { goHome(); closeDrawers(); };

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

/* ---------- 全文检索（懒加载语料，子串扫描） ---------- */
let searchIndex = null;
let pendingFind = '';

async function fullSearch(kw) {
  const tree = $('#nav-tree');
  if (!searchIndex) {
    tree.innerHTML = '<p class="nav-empty">正在载入全文索引…<br><small>首次约数秒，此后离线可用</small></p>';
    try {
      searchIndex = await (await fetch('/data/search.json', { cache: 'no-cache' })).json();
    } catch {
      tree.innerHTML = '<p class="nav-empty">索引载入失败，请检查网络</p>';
      return;
    }
  }
  const hits = [];
  for (const rec of searchIndex) {
    const idx = rec.x.indexOf(kw);
    if (idx === -1 && !rec.t.includes(kw)) continue;
    let snip = '';
    if (idx >= 0) {
      const from = Math.max(0, idx - 22);
      const raw = rec.x.slice(from, idx + kw.length + 34).replace(/\n/g, ' ');
      const at = idx - from;
      snip = (from > 0 ? '…' : '') + esc(raw.slice(0, at)) +
        '<mark>' + esc(kw) + '</mark>' + esc(raw.slice(at + kw.length)) + '…';
    }
    hits.push({ id: rec.i, t: rec.t, v: rec.v, snip });
    if (hits.length >= 100) break;
  }
  tree.innerHTML = `<p class="search-count">全文命中 ${hits.length}${hits.length >= 100 ? '+' : ''} 篇</p>` +
    (hits.length ? hits.map((h) => `
      <button class="search-hit" data-id="${h.id}">
        <span class="sh-title">${esc(h.t)}</span><span class="sh-vol">${esc(h.v)}</span>
        ${h.snip ? `<span class="sh-snip">${h.snip}</span>` : ''}
      </button>`).join('') : '<p class="nav-empty">没有找到「' + esc(kw) + '」</p>');
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
  // 影像陈列页：内容随静态页预渲染，app.js 不重绘，仅同步标题/繁体
  if (/^\/ying\/?$/.test(location.pathname)) {
    current = null;
    showSpeakBtn(false);
    $('#topbar-title').textContent = '印祖法相';
    $('#ai-context').textContent = '基于印光法师文钞全集';
    maybeTradify($('#reader'));
    return;
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
function renderHome() {
  current = null;
  showSpeakBtn(false);
  $('#topbar-title').textContent = '印光法师文钞';
  $('#ai-context').textContent = '基于印光法师文钞全集';
  const total = flat.length;
  const resume = lastRead && progress[lastRead.id]
    ? `<button class="resume-card" data-id="${lastRead.id}">
         <small>继续阅读</small>
         <strong>${esc(lastRead.title)}</strong>
         <span class="pct">${Math.round((progress[lastRead.id].pct || 0) * 100)}%</span>
       </button>`
    : '';
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
      ${resume}
      <h2>${books.length} 部 · 共 ${total} 篇</h2>
      ${vols}
      <div class="home-extra">
        <a class="home-cta" href="/ying/">瞻礼 · 印祖法相与传印长老题词 →</a>
      </div>
      <p class="home-note">底本为《印光法师文钞》增广、续编、三编及三编补之文白对照本。文言原文与白话译文逐篇对照排录；正文中带朱点之词语，点按可查名相注释。<br>愿见闻者，同沾法益。</p>
    </div>`;
  paintProgress();
  const rc = $('.resume-card');
  if (rc) rc.onclick = () => { goArticle(rc.dataset.id); };
  document.querySelectorAll('.vol-card').forEach((b) => {
    b.onclick = () => {
      openDrawer('L');
      const el = $(`.nav-vol[data-vol="${b.dataset.vol}"]`);
      if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); }
    };
  });
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
    showSpeakBtn(false);
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
  const modeBar = (!art.plain && hasTrans)
    ? `<div class="mode-bar" role="tablist">
        <button class="seg" data-m="orig">原文</button>
        <button class="seg" data-m="both">对照</button>
        <button class="seg" data-m="trans">白话</button>
      </div>` : '';

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

  // 模式切换
  reader.querySelectorAll('.mode-bar .seg').forEach((b) => {
    b.classList.toggle('on', b.dataset.m === prefs.mode);
    b.onclick = () => {
      stopRead();     // 切换原文/白话/对照 → 可见段落变了，停读重来
      prefs.mode = b.dataset.m;
      store.set('mode', prefs.mode);
      reader.querySelector('.art-body').dataset.mode = prefs.mode;
      reader.querySelectorAll('.mode-bar .seg').forEach((x) =>
        x.classList.toggle('on', x === b));
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

  // 搜索跳转：高亮全文命中并定位首处；否则恢复阅读进度
  if (pendingFind) {
    const first = markInRoot(reader.querySelector('.reader-inner'), pendingFind);
    pendingFind = '';
    if (first) first.scrollIntoView({ block: 'center' });
    else scrollTo(0, 0);
  } else {
    const saved = progress[id];
    scrollTo(0, saved && saved.pct > 0.02
      ? saved.pct * (document.body.scrollHeight - innerHeight) : 0);
  }

  lastRead = { id, title: art.title };
  store.set('lastRead', lastRead);
  highlightNav();
  paintProgress();
  showSpeakBtn(true);     // 文章就绪 → 显示朗读键
}

/* 阅读进度：顶部细线实时更新（rAF），localStorage 节流保存 */
const progressBar = $('#read-progress');
let scrollTimer = null, rafPending = false;
function paintProgress() {
  rafPending = false;
  const max = document.body.scrollHeight - innerHeight;
  progressBar.style.width = (current && max > 200)
    ? Math.min(100, scrollY / max * 100) + '%' : '0';
}
addEventListener('scroll', () => {
  if (!rafPending) { rafPending = true; requestAnimationFrame(paintProgress); }
  if (!current || scrollTimer) return;
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    const max = document.body.scrollHeight - innerHeight;
    if (max > 200) {
      progress[current.id] = { pct: Math.min(1, scrollY / max), t: Date.now() };
      store.set('progress', progress);
    }
  }, 600);
}, { passive: true });

/* ---------- 注释弹卡 ---------- */
const sheet = $('#sheet'), sheetBd = $('#sheet-backdrop');
function openSheet(note) {
  $('#sheet-body').innerHTML = `
    <h4>${note.term ? '【' + esc(note.term) + '】' : '注释'}<span class="note-n">本篇注释 [${note.n}]</span></h4>
    <p>${esc(note.text)}</p>`;
  sheet.hidden = false; sheetBd.hidden = false;
}
function closeSheet() { sheet.hidden = true; sheetBd.hidden = true; }
sheetBd.onclick = closeSheet;
sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };

/* ---------- 正文朗读 / 跟读高亮 ----------
   speechSynthesis 逐句朗读当前可见正文（随阅读模式：原文 / 白话 / 对照）；
   当前句以 Custom Highlight API 高亮（不改 DOM，保留名相·角标可点），并自动滚动跟随。
   暂停=取消当前句、恢复=从本句重读（比 pause/resume 在安卓上更稳）。 */
const speakBtn = $('#btn-speak');
const synthOK = () => 'speechSynthesis' in window;
const RATES = [0.75, 0.95, 1.2];
const rateLabel = (r) => (r <= 0.8 ? '慢' : r >= 1.2 ? '快' : '常') + '速';
const READ = { units: [], idx: 0, on: false, paused: false, cur: null, bar: null, rate: store.get('ttsRate', 0.95) };
// 优先用 Custom Highlight API（句级、零 DOM 改动）；不支持则退化为 .reading-para 段级高亮
const HL = (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') ? new Highlight() : null;
if (HL) CSS.highlights.set('wc-read', HL);
const RB_ICON = {
  play: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  prev: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 6h2v12H7zM20 6 11 12l9 6z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M15 6h2v12h-2zM4 6l9 6-9 6z"/></svg>',
};

// 文章页才显示朗读键（设备不支持 TTS 则始终隐藏）；切走时一并停读
function showSpeakBtn(on) {
  if (!speakBtn) return;
  speakBtn.hidden = !(on && synthOK());
  if (!on) stopRead();
}

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
function buildUnits() {
  const els = [...$('#reader').querySelectorAll('.art-title, .art-body .p-orig, .art-body .p-trans')]
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
  bar.innerHTML =
    `<button class="rb-btn rb-prev" type="button" aria-label="上一句">${RB_ICON.prev}</button>` +
    `<button class="rb-btn rb-play" type="button" aria-label="暂停">${RB_ICON.pause}</button>` +
    `<button class="rb-btn rb-next" type="button" aria-label="下一句">${RB_ICON.next}</button>` +
    `<button class="rb-rate" type="button" aria-label="切换语速">常速</button>` +
    `<button class="rb-x" type="button" aria-label="结束朗读">×</button>`;
  document.body.appendChild(bar);
  bar.querySelector('.rb-prev').onclick = () => jumpRead(-1);
  bar.querySelector('.rb-next').onclick = () => jumpRead(1);
  bar.querySelector('.rb-play').onclick = togglePause;
  bar.querySelector('.rb-rate').onclick = cycleRate;
  bar.querySelector('.rb-x').onclick = stopRead;
  READ.bar = bar;
  return bar;
}
function syncBar() {
  if (!READ.bar) return;
  const play = READ.bar.querySelector('.rb-play');
  play.innerHTML = READ.paused ? RB_ICON.play : RB_ICON.pause;
  play.setAttribute('aria-label', READ.paused ? '继续朗读' : '暂停');
  READ.bar.querySelector('.rb-rate').textContent = rateLabel(READ.rate);
}

function speakIdx(i) {
  if (i < 0) i = 0;
  if (i >= READ.units.length) { stopRead(); return; }   // 读完：自动结束
  READ.idx = i;
  const u = READ.units[i];
  markUnit(u); scrollUnit(u);
  const utt = new SpeechSynthesisUtterance(speakable(u.text));
  utt.lang = 'zh-CN'; utt.rate = READ.rate;
  const v = pickVoice(); if (v) utt.voice = v;
  // 仅当本句仍是「当前句」（未被取消/切走）才推进，避免取消触发的回调误进下一句
  utt.onend = () => { if (READ.on && !READ.paused && READ.cur === utt) speakIdx(READ.idx + 1); };
  utt.onerror = () => { if (READ.on && !READ.paused && READ.cur === utt) speakIdx(READ.idx + 1); };
  READ.cur = utt;
  try { window.speechSynthesis.speak(utt); } catch {}
}
function startRead() {
  if (!current || !synthOK()) return;
  READ.units = buildUnits();
  if (!READ.units.length) return;
  window.speechSynthesis.cancel();
  READ.on = true; READ.paused = false;
  if (speakBtn) speakBtn.classList.add('on');
  ensureReadBar().hidden = false;
  syncBar();
  speakIdx(0);
}
function stopRead() {
  if (synthOK()) window.speechSynthesis.cancel();
  READ.on = false; READ.paused = false; READ.cur = null; READ.units = [];
  clearHL();
  if (speakBtn) speakBtn.classList.remove('on');
  if (READ.bar) READ.bar.hidden = true;
}
function togglePause() {
  if (!READ.on) return;
  if (READ.paused) { READ.paused = false; syncBar(); speakIdx(READ.idx); }
  else { READ.paused = true; READ.cur = null; if (synthOK()) window.speechSynthesis.cancel(); syncBar(); }
}
function jumpRead(d) {
  if (!READ.on) return;
  READ.paused = false; READ.cur = null;
  if (synthOK()) window.speechSynthesis.cancel();
  syncBar(); speakIdx(READ.idx + d);
}
function cycleRate() {
  READ.rate = RATES[(RATES.indexOf(READ.rate) + 1) % RATES.length];
  store.set('ttsRate', READ.rate);
  syncBar();
  if (READ.on && !READ.paused) { READ.cur = null; if (synthOK()) window.speechSynthesis.cancel(); speakIdx(READ.idx); }
}
if (speakBtn) speakBtn.onclick = () => { READ.on ? stopRead() : startRead(); };

/* ---------- 偏好控件 ---------- */
$('#font-inc').onclick = () => { prefs.fs = Math.min(24, prefs.fs + 1); store.set('fs', prefs.fs); applyPrefs(); };
$('#font-dec').onclick = () => { prefs.fs = Math.max(14, prefs.fs - 1); store.set('fs', prefs.fs); applyPrefs(); };
const setTheme = (name) => { prefs.theme = name; store.set('theme', name); applyPrefs(); };
$('#theme-paper').onclick = () => setTheme('paper');
if ($('#theme-plain')) $('#theme-plain').onclick = () => setTheme('plain');
$('#theme-night').onclick = () => setTheme('night');

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
if ($('#cc-simp')) $('#cc-simp').onclick = () => setTrad(false);
if ($('#cc-trad')) $('#cc-trad').onclick = () => setTrad(true);

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
// 角标 hover 预览（仅桌面；触屏走点击弹卡）
let aiTip;
// 仅"有真鼠标"的桌面启用 hover 预览；手机/触屏一律走点按弹卡
const canHover = () => window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
function citeHover(btn, p) {
  if (!p || !canHover()) return;
  btn.addEventListener('mouseenter', () => {
    if (!aiTip) { aiTip = document.createElement('div'); aiTip.className = 'ai-tip'; document.body.appendChild(aiTip); }
    const orig = citationExcerpt(p);
    aiTip.innerHTML = `<b>《${esc(p.title || '')}》</b>${esc(orig.slice(0, 80))}${orig.length > 80 ? '…' : ''}`;
    aiTip.hidden = false;
    const r = btn.getBoundingClientRect();
    aiTip.style.left = Math.max(8, Math.min(r.left, innerWidth - aiTip.offsetWidth - 12)) + 'px';
    aiTip.style.top = (r.bottom + 6) + 'px';
  });
  btn.addEventListener('mouseleave', () => { if (aiTip) aiTip.hidden = true; });
}
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

  let passages = null, full = '', div = null, lastPaint = 0;
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
    aiFeedback(ensureDiv(), q, full, passages);
    aiSession.push({ r: 'u', c: q });
    aiSession.push({ r: 'b', c: full, p: passages || [], q });
    saveSession();
  }
}
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).catch(() => execCopy(t));
  else execCopy(t);
}
function execCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.top = '-1000px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}
// 反馈闭环：有帮助 / 需更正 → 存后端，供日后善知识审核沉淀；+ 复制
const FB_ICON = {
  up: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  speak: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4z"/><path d="M16 9a3.5 3.5 0 0 1 0 6M19 6.5a7 7 0 0 1 0 11"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>',
};
// 把一问一答制成可转发的图（复用 share.js 的卡片/二维码/系统分享）
function aiShare(question, reply, passages) {
  if (!(window.WenchaoShare && window.WenchaoShare.aiCard)) { copyText(reply); return; }
  const body = (reply || '')
    .replace(/\[\d{1,2}\]/g, '').replace(/\*\*/g, '')
    .replace(/^\s*#{1,4}\s*/gm, '').replace(/^\s*\d+[.、)]\s*/gm, '')
    .replace(/^\s*[-*•●○◦·]\s+/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  // 二维码直达独立 AI 页 /ask/；AI 问答卡见 share.js 的 drawAICard
  const base = (CFG.shareBase || location.origin).replace(/\/$/, '');
  window.WenchaoShare.aiCard(question, body, base + '/ask/');
}
// 朗读：浏览器免费 TTS（speechSynthesis）；佛教高频词读音替换（仅朗读用，不改显示）
const PRON = [['南无', '南摩'], ['南無', '南摩'], ['般若', '波惹'], ['伽蓝', '茄蓝'], ['阿弥陀', '婀弥陀'], ['比丘', '笔丘'], ['迦叶', '迦摄']];
function speakable(t) {
  t = t.replace(/\[\d{1,2}\]/g, '').replace(/\*\*/g, '')
    .replace(/^\s*\d+[.、)]\s*/gm, '').replace(/^\s*[-*•●]\s*/gm, '');
  PRON.forEach(([a, b]) => { t = t.split(a).join(b); });
  return t;
}
function aiSpeak(text, btn) {
  const synth = window.speechSynthesis;
  if (!synth) { btn.title = '此设备暂不支持朗读'; return; }
  if (btn.classList.contains('on')) { synth.cancel(); return; }   // 再点=停止
  synth.cancel();
  const u = new SpeechSynthesisUtterance(speakable(text));
  u.lang = 'zh-CN'; u.rate = 0.95;
  const v = (synth.getVoices() || []).find((x) => /zh|chinese|中文|普通话/i.test((x.lang || '') + (x.name || '')));
  if (v) u.voice = v;
  btn.classList.add('on'); btn.innerHTML = FB_ICON.stop; btn.title = '停止朗读';
  u.onend = u.onerror = () => { btn.classList.remove('on'); btn.innerHTML = FB_ICON.speak; btn.title = '朗读'; };
  synth.speak(u);
}
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
  if (window.speechSynthesis) window.speechSynthesis.cancel();
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
