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
/* 卷名缩写：「增广印光法师文钞卷第一」→「卷第一」 */
const shortJuan = (j) => j.replace(/^(增广)?印光法师文钞(续编|三编)?/, '') || j;

function applyPrefs() {
  document.documentElement.style.setProperty('--fs', prefs.fs + 'px');
  document.documentElement.dataset.theme = prefs.theme === 'night' ? 'night' : '';
  document.querySelector('meta[name=theme-color]')
    .setAttribute('content', prefs.theme === 'night' ? '#171310' : '#f6f1e6');
  $('#theme-paper').classList.toggle('on', prefs.theme !== 'night');
  $('#theme-night').classList.toggle('on', prefs.theme === 'night');
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
}
$('#btn-nav').onclick = () => openDrawer('L');
$('#btn-ai').onclick = () => openDrawer('R');
$('#btn-ai-close').onclick = closeDrawers;
overlay.onclick = closeDrawers;
$('#topbar-title').onclick = () => { location.hash = ''; closeDrawers(); };

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
      searchIndex = await (await fetch('data/search.json', { cache: 'no-cache' })).json();
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
      location.hash = '#/a/' + b.dataset.id;
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
    $('#ft-go').onclick = () => fullSearch(kw);
    return;
  }
  tree.innerHTML = books.map((vol) => {
    const count = vol.juans.reduce((n, j) => n + j.cats.reduce((m, c) => m + c.items.length, 0), 0);
    const juans = vol.juans.map((j) => {
      const cats = j.cats.map((c) =>
        (c.name && c.name !== '正文' ? `<div class="nav-cat-label">${esc(c.name)}</div>` : '') +
        c.items.map((it) => navItemHtml(it)).join('')
      ).join('');
      return `<details class="nav-juan"><summary><span class="tri"></span>${esc(shortJuan(j.name))}</summary>${cats}</details>`;
    }).join('');
    return `<details class="nav-vol" data-vol="${vol.id}"><summary><span class="tri"></span>${esc(vol.name)}<span class="count">${count}篇</span></summary>${juans}</details>`;
  }).join('');
  bindNavItems(tree);
}
const navItemHtml = (it, withVol) => {
  const visited = progress[it.id] ? ' visited' : '';
  const active = current && current.id === it.id ? ' active' : '';
  const sub = withVol ? `<small style="color:var(--ink-3)"> · ${esc(it.volName || '')}</small>` : '';
  return `<button class="nav-item${visited}${active}" data-id="${it.id}">${esc(it.title)}${sub}</button>`;
};
function bindNavItems(root) {
  root.querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => { location.hash = '#/a/' + b.dataset.id; closeDrawers(); };
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
window.addEventListener('hashchange', route);
async function route() {
  const m = location.hash.match(/^#\/a\/([\w-]+)/);
  closeDrawers();
  if (!m) { renderHome(); return; }
  await renderArticle(m[1]);
}

/* ---------- 首页 ---------- */
function renderHome() {
  current = null;
  $('#topbar-title').textContent = '印光法师文钞';
  $('#ai-context').textContent = '未在阅读篇目';
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
  if (rc) rc.onclick = () => { location.hash = '#/a/' + rc.dataset.id; };
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
  const res = await fetch('data/articles/' + id + '.json', { cache: 'no-cache' });
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
  $('#ai-context').textContent = '当前阅读：' + art.title;

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

  reader.innerHTML = `<div class="reader-inner">
      ${modeBar}
      <header class="art-head">
        <div class="art-crumb">${esc(crumb)}</div>
        <h1 class="art-title">${esc(art.title)}</h1>
        <div class="rule"></div>
      </header>
      ${art.summary ? `<div class="art-summary"><b>提 要</b>${esc(art.summary)}</div>` : ''}
      <article class="art-body" data-mode="${hasTrans ? prefs.mode : 'orig'}">${body}</article>
      ${notesHtml}
      ${navHtml}
    </div>`;

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
    b.onclick = () => { location.hash = '#/a/' + b.dataset.id; };
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

/* ---------- AI 助读 ---------- */
const aiLog = $('#ai-log');
const aiHistory = [];
function aiAppend(role, text, cite) {
  const div = document.createElement('div');
  div.className = 'ai-msg ' + (role === 'user' ? 'user' : 'bot');
  div.innerHTML = esc(text).replace(/\n/g, '<br>') +
    (cite ? `<cite>${esc(cite)}</cite>` : '');
  aiLog.appendChild(div);
  aiLog.scrollTop = aiLog.scrollHeight;
}
async function aiAsk(q) {
  aiAppend('user', q);
  aiHistory.push({ role: 'user', content: q });
  if (!CFG.aiEndpoint) {
    aiAppend('bot',
      'AI 服务尚未接入。\n部署时需在 config.js 中配置 aiEndpoint（指向你的 Cloudflare Worker 代理），即可基于当前篇目原文进行解读与答疑。',
      '当前为本地预览模式');
    return;
  }
  aiAppend('bot', '思考中…');
  const placeholder = aiLog.lastChild;
  try {
    const res = await fetch(CFG.aiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        articleId: current ? current.id : null,
        title: current ? current.title : null,
        messages: aiHistory.slice(-8),
      }),
    });
    const data = await res.json();
    placeholder.remove();
    aiAppend('bot', data.reply || '（无回复）', data.cite || '');
    aiHistory.push({ role: 'assistant', content: data.reply || '' });
  } catch {
    placeholder.remove();
    aiAppend('bot', '请求失败，请稍后重试。');
  }
}
$('#ai-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#ai-text').value.trim();
  if (!v) return;
  $('#ai-text').value = '';
  aiAsk(v);
};
document.querySelectorAll('#ai-chips .chip-btn').forEach((b) => {
  b.onclick = () => aiAsk((current ? `关于《${current.title}》：` : '') + b.dataset.q);
});

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
    books = await (await fetch('data/books.json', { cache: 'no-cache' })).json();
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
  route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost'))
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
