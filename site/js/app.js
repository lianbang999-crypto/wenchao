/* ===================================================================
   印光法师文钞 · 文白对照 阅读器
   纯前端、无构建：books.json 目录树 + articles/{id}.json 按篇懒加载
   =================================================================== */

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

function applyPrefs() {
  document.documentElement.style.setProperty('--fs', prefs.fs + 'px');
  document.documentElement.dataset.theme = prefs.theme === 'night' ? 'night' : '';
  document.querySelector('meta[name=theme-color]')
    .setAttribute('content', prefs.theme === 'night' ? '#171310' : '#f6f1e6');
  $('#theme-paper').classList.toggle('on', prefs.theme !== 'night');
  $('#theme-night').classList.toggle('on', prefs.theme === 'night');
  if ($('#cc-simp')) $('#cc-simp').classList.toggle('on', !prefs.trad);
  if ($('#cc-trad')) $('#cc-trad').classList.toggle('on', prefs.trad);
}

/* ---------- 抽屉 ---------- */
const drawerL = $('#drawer-left'), drawerR = $('#drawer-right'), overlay = $('#overlay');
const isWide = () => matchMedia('(min-width: 1180px)').matches;

function openDrawer(side) {
  if (isWide()) return;
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
  const r = articleRoute();
  closeDrawers();
  if (!r) { renderHome(); maybeTradify($('#reader')); return; }
  await renderArticle(r.id);
  maybeTradify($('#reader'));     // 繁体模式：正文渲染后转换
  // 分享二维码深链：?p=N 定位到所引段落
  if (r.p !== null && r.p !== undefined && r.p !== '') scrollToPara(+r.p);
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
  const crumb = [art.volumeName, shortJuan(art.juan || ''), art.category, art.translator]
    .filter(Boolean).join(' · ');

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
        <div class="art-crumb">${esc(crumb)}</div>
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

/* ---------- 偏好控件 ---------- */
$('#font-inc').onclick = () => { prefs.fs = Math.min(24, prefs.fs + 1); store.set('fs', prefs.fs); applyPrefs(); };
$('#font-dec').onclick = () => { prefs.fs = Math.max(14, prefs.fs - 1); store.set('fs', prefs.fs); applyPrefs(); };
$('#theme-paper').onclick = () => { prefs.theme = 'paper'; store.set('theme', prefs.theme); applyPrefs(); };
$('#theme-night').onclick = () => { prefs.theme = 'night'; store.set('theme', prefs.theme); applyPrefs(); };

/* ---------- 简繁转换（OpenCC 自托管，懒加载；仅显示层，不改底本数据）---------- */
let _conv = null;
function loadOpenCC() {
  if (_conv) return Promise.resolve(_conv);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/js/opencc.js?v=20260614-ai13';
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
const aiHistory = [];
function aiAppend(role, text, passages) {
  const div = document.createElement('div');
  div.className = 'ai-msg ' + (role === 'user' ? 'user' : 'bot');
  if (role === 'user') {
    div.textContent = text;
  } else {
    div.innerHTML = aiFormat(text, passages);
    div.querySelectorAll('.ai-cite').forEach((b) => {
      const p = passages[+b.dataset.n - 1];
      b.onclick = () => showCitation(p);
      citeHover(b, p);
    });
  }
  aiLog.appendChild(div);
  aiLog.scrollTop = aiLog.scrollHeight;
  return div;
}
// 轻量 Markdown（粗体 / 有序·无序列表 / 段落）+ 行内角标 [n]
function aiFormat(text, passages) {
  let t = esc(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  let html = '', list = '';
  const close = () => { if (list) { html += '</' + list + '>'; list = ''; } };
  for (const raw of t.split('\n')) {
    const ln = raw.trim();
    if (!ln) continue;   // 空行跳过即可，勿关闭列表（否则每项各成一个 ol、序号都回到1）
    let m;
    if ((m = ln.match(/^(\d+)[.、)]\s*(.+)$/))) {
      if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; }
      html += '<li>' + m[2] + '</li>';
    } else if ((m = ln.match(/^[-*●·•]\s+(.+)$/))) {
      if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; }
      html += '<li>' + m[1] + '</li>';
    } else {
      close(); html += '<p>' + ln + '</p>';
    }
  }
  close();
  if (passages && passages.length) {
    html = html.replace(/\[(\d{1,2})\]/g, (mm, n) =>
      passages[+n - 1] ? '<button class="ai-cite" data-n="' + n + '">' + n + '</button>' : mm);
  }
  return html;
}
// 点角标 → 底部弹卡显示出处原文 + 阅读全篇（统一只显原文，白话在「阅读全篇」里）
function showCitation(p) {
  if (!p) return;
  const orig = (p.text || '').split('\n（白话）')[0];
  $('#sheet-body').innerHTML =
    `<h4>《${esc(p.title || '')}》<span class="note-n">出处原文</span></h4>` +
    `<p class="cite-text">${esc(orig)}</p>` +
    (p.aid ? `<button class="sheet-goto" data-id="${esc(p.aid)}">阅读全篇 ›</button>` : '');
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  const g = $('#sheet-body .sheet-goto');
  if (g) g.onclick = () => {
    $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true;
    goArticle(g.dataset.id); closeDrawers();
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
    const orig = (p.text || '').split('\n（白话）')[0];
    aiTip.innerHTML = `<b>《${esc(p.title || '')}》</b>${esc(orig.slice(0, 80))}${orig.length > 80 ? '…' : ''}`;
    aiTip.hidden = false;
    const r = btn.getBoundingClientRect();
    aiTip.style.left = Math.max(8, Math.min(r.left, innerWidth - aiTip.offsetWidth - 12)) + 'px';
    aiTip.style.top = (r.bottom + 6) + 'px';
  });
  btn.addEventListener('mouseleave', () => { if (aiTip) aiTip.hidden = true; });
}
// 首次进入的欢迎引导语（仅展示，不计入对话历史）
function aiWelcome() {
  if (aiLog.children.length) return;
  const div = document.createElement('div');
  div.className = 'ai-welcome';
  div.textContent = '南无阿弥陀佛。可就《印光法师文钞》全集随心提问——念佛、信愿、因果、临终助念等皆可。回答据大师原文，并附可点出处；义理以原文为准。可点上方常见问题，或在下方输入。';
  aiLog.appendChild(div);
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
    d.querySelectorAll('.ai-cite').forEach((b) => {
      const p = passages && passages[+b.dataset.n - 1];
      b.onclick = () => showCitation(p); citeHover(b, p);
    });
    aiLog.scrollTop = aiLog.scrollHeight;
  };
  const onMsg = (m) => {
    if (m.type === 'meta') passages = m.passages;
    else if (m.type === 'delta') {
      full += m.text;
      const t = Date.now();
      if (t - lastPaint > 120) { lastPaint = t; paint(); }   // 节流，避免每字重排
    }
  };

  aiAbort = new AbortController();
  const sb = aiSendBtn(); if (sb) sb.textContent = '停止';
  let failed = false;
  try {
    const res = await fetch(CFG.aiEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: aiHistory.slice(-8) }), signal: aiAbort.signal,
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
  if (full !== '（无回复）') aiFeedback(ensureDiv(), q, full);
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
};
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
function aiFeedback(el, question, reply) {
  const bar = document.createElement('div');
  bar.className = 'ai-fb';
  bar.innerHTML =
    '<button class="ai-fb-btn ai-speak" type="button" title="朗读" aria-label="朗读">' + FB_ICON.speak + '</button>' +
    '<button class="ai-fb-btn ai-copy" type="button" title="复制回答" aria-label="复制回答">' + FB_ICON.copy + '</button>' +
    '<span class="ai-fb-gap"></span>' +
    '<button class="ai-fb-btn" data-v="up" type="button" title="有帮助" aria-label="有帮助">' + FB_ICON.up + '</button>' +
    '<button class="ai-fb-btn" data-v="down" type="button" title="需更正" aria-label="需更正">' + FB_ICON.down + '</button>';
  el.appendChild(bar);
  bar.querySelector('.ai-speak').onclick = function () { aiSpeak(reply, this); };
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
if (aiNewBtn) aiNewBtn.onclick = () => {     // 新对话：清空重来
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (aiAbort) aiAbort.abort();
  aiHistory.length = 0;
  aiLog.innerHTML = '';
  aiWelcome();
};
aiWelcome();

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
  if (prefs.trad) loadOpenCC().then(() => { tradify($('#reader')); tradify($('#nav-tree')); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot();
