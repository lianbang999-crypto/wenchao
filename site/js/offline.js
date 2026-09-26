/* 整册离线下载。
   把整册 / 全集的 data/articles/{id}.json 预存进独立缓存 wc-dl；
   断网时 sw.js 的「网络失败 → caches.match」会自动跨 cache 命中，无需改 app.js。
   注释内嵌在每篇 JSON 内，故离线阅读只需缓存这些文件 + 已在外壳里的 books.json。
   全文搜索查后端 D1 索引，需联网；离线时篇名搜索（本地目录过滤）仍可用。 */
(function () {
  'use strict';

  var DL = 'wc-dl';
  var LS = 'wc-dl-state';
  var MANIFEST_URL = '/app/content-manifest.json';
  // Cache Storage 内部快照键，并非服务器上的文件。
  var CATALOG_KEY = '/__wc-offline-catalog__/manifest';
  var CONC = 6;
  var BOOKS = null, MANIFEST = null, STATUS = {};
  var checking = false, catalogOnline = false, catalogError = '';
  var active = null, cancelFlag = false;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  if (!('caches' in window)) {
    document.addEventListener('DOMContentLoaded', function () {
      var b = $('#offline-open'); if (b) { b.disabled = true; b.title = '当前浏览器不支持离线缓存'; }
    });
    return;
  }

  function getState() {
    try { var s = JSON.parse(localStorage.getItem(LS) || '{}'); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; }
    catch (e) { return {}; }
  }
  function setState(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch (e) {} }
  function mark(scope, on) {
    var s = getState();
    if (on) s[scope] = { time: Date.now(), version: MANIFEST && MANIFEST.version };
    else delete s[scope];
    setState(s);
  }
  function idsOfBook(book) {
    var ids = [];
    (book.juans || []).forEach(function (j) {
      (j.cats || []).forEach(function (c) {
        (c.items || []).forEach(function (it) { if (it && it.id) ids.push(it.id); });
      });
    });
    return ids;
  }
  function articleUrl(id) { return '/data/articles/' + id + '.json'; }
  function urlsFor(ids) { return ids.map(articleUrl); }
  function hashBytes(bytes) {
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error('当前浏览器无法校验文本，请使用 HTTPS 或更新浏览器'));
    return window.crypto.subtle.digest('SHA-1', bytes).then(function (hash) {
      return Array.prototype.map.call(new Uint8Array(hash), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('').slice(0, 12);
    });
  }
  function parseBytes(bytes) { return JSON.parse(new TextDecoder().decode(bytes)); }
  function validateManifest(m) {
    if (!m || typeof m.version !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(m.version) ||
        !m.articles || typeof m.articles !== 'object' || Array.isArray(m.articles) ||
        !/^[a-f0-9]{12}$/.test(m.books) || m.count !== Object.keys(m.articles).length || m.count < 1) throw new Error('文本清单格式不正确');
    Object.keys(m.articles).forEach(function (id) {
      if (!/^[\w-]+$/.test(id) || !/^[a-f0-9]{12}$/.test(m.articles[id])) throw new Error('文本清单格式不正确');
    });
    return m;
  }
  function useCatalog(m, list) {
    if (!Array.isArray(list) || !list.length) throw new Error('目录格式不正确');
    var all = [], books = list.map(function (b) {
      var ids = idsOfBook(b);
      if (!b.id || !b.name || !ids.length || ids.some(function (id) { return !m.articles[id]; })) throw new Error('目录与文本版本不一致');
      all = all.concat(ids);
      return { id: b.id, name: b.name, ids: ids, count: ids.length };
    });
    if (new Set(all).size !== m.count || all.length !== m.count) throw new Error('目录与文本版本不一致');
    MANIFEST = m;
    BOOKS = [{ id: '__all__', name: '全部文钞', ids: all, count: all.length }].concat(books);
  }
  function network(url, job) {
    var ctrl = new AbortController();
    if (job) job.controllers.push(ctrl);
    var timer = setTimeout(function () { ctrl.abort(); }, 10000);
    return fetch(url, { cache: 'no-store', headers: { 'X-WC-Prefetch': '1' }, signal: ctrl.signal })
      .then(function (res) { if (!res.ok) throw new Error('取数失败'); return res; })
      .finally(function () {
        clearTimeout(timer);
        if (job) job.controllers = job.controllers.filter(function (c) { return c !== ctrl; });
      });
  }
  async function loadCatalog() {
    var cache = await caches.open(DL);
    try {
      var responses = await Promise.all([network(MANIFEST_URL), network('/data/books.json')]);
      var m = validateManifest(await responses[0].json());
      var bytes = await responses[1].arrayBuffer();
      if (await hashBytes(bytes) !== m.books) throw new Error('目录校验失败，请稍后重试');
      var list = parseBytes(bytes);
      useCatalog(m, list);
      catalogOnline = true; catalogError = '';
      // 一份响应保存完整目录快照，避免中途失败留下清单与目录两个版本。
      try { await cache.put(CATALOG_KEY, new Response(JSON.stringify({ manifest: m, books: list }), { headers: { 'Content-Type': 'application/json' } })); }
      catch (e) { catalogError = '版本信息暂未保存；已下载正文仍可阅读。'; }
    } catch (err) {
      catalogOnline = false;
      catalogError = '未能联网检查更新；保留本机文本。';
      if (!MANIFEST) {
        var saved = await cache.match(CATALOG_KEY);
        if (saved) {
          var snapshot = await saved.json();
          useCatalog(validateManifest(snapshot.manifest), snapshot.books);
        } else {
          // 旧版下载没有清单，仍显示已存篇目并允许清除，联网后才能核对版本。
          var res = await caches.match('/data/books.json');
          if (!res) throw err;
          var oldBooks = await res.json(), all = [];
          BOOKS = oldBooks.map(function (b) { var ids = idsOfBook(b); all = all.concat(ids); return { id: b.id, name: b.name, ids: ids, count: ids.length }; });
          BOOKS.unshift({ id: '__all__', name: '全部文钞', ids: all, count: all.length });
        }
      }
    }
  }
  async function cachedHash(res) {
    // 旧版缓存没有摘要：读实际字节核验，不能把旧副本直接认作最新。
    return res.headers.get('X-WC-Content-Hash') || hashBytes(await res.clone().arrayBuffer());
  }
  async function inspectLocal() {
    var cache = await caches.open(DL), ids = BOOKS[0].ids, i = 0, found = {};
    async function worker() {
      while (i < ids.length) {
        var id = ids[i++], res = await cache.match(articleUrl(id));
        if (res) {
          found[id] = 1;
          if (MANIFEST) try { if (await cachedHash(res) === MANIFEST.articles[id]) found[id] = 2; } catch (e) {}
        }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    STATUS = {};
    BOOKS.forEach(function (bk) {
      var present = bk.ids.filter(function (id) { return found[id]; }).length;
      var current = bk.ids.filter(function (id) { return found[id] === 2; }).length;
      STATUS[bk.id] = { present: present, current: current, pending: bk.count - current };
      if (present < bk.count) mark(bk.id, false);
    });
  }
  async function validatedArticle(res, id, expected) {
    var bytes = await res.arrayBuffer(), data = parseBytes(bytes);
    if (!data || data.id !== id || !Array.isArray(data.segments) || !data.segments.length ||
        data.segments.some(function (seg) { return !seg || !Array.isArray(seg.orig) || !Array.isArray(seg.trans); })) throw new Error('正文格式校验失败');
    if (await hashBytes(bytes) !== expected) throw new Error('正文版本校验失败');
    var headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'X-WC-Content-Hash': expected });
    return new Response(bytes, { headers: headers });
  }

  async function downloadUrls(ids, onProgress) {
    cancelFlag = false;
    var cache = await caches.open(DL), manifest = MANIFEST, job = active;
    var i = 0, done = 0, ok = 0, failed = 0, updated = 0, quotaHit = false, netFail = 0, changed = [];
    async function worker() {
      while (i < ids.length && !cancelFlag && !quotaHit && netFail < 12) {
        var id = ids[i++], u = articleUrl(id);
        try {
          var hit = await cache.match(u);
          if (hit && await cachedHash(hit) === manifest.articles[id]) { ok++; }
          else {
            var res = await network(u, job);
            var checked = await validatedArticle(res, id, manifest.articles[id]);
            netFail = 0;
            if (cancelFlag || quotaHit) break;
            try {
              // 不先删旧副本；验证/下载/写入任一失败，旧文本仍然可读。
              await cache.put(u, checked);
              ok++; updated++; changed.push(id);
            } catch (err) { quotaHit = true; failed++; }
          }
        } catch (err) { if (!cancelFlag) { failed++; netFail++; } }
        done++; if (onProgress) onProgress(done, ids.length);
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    if (changed.length) window.dispatchEvent(new CustomEvent('wc-content-updated', { detail: { ids: changed } }));
    return { done: done, ok: ok, updated: updated, failed: failed, cancelled: cancelFlag, quotaHit: quotaHit, aborted: netFail >= 12 };
  }
  async function clearUrls(urls) {
    var cache = await caches.open(DL);
    await Promise.all(urls.map(function (u) { return cache.delete(u); }));
  }

  function usageText() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve('');
    return navigator.storage.estimate().then(function (e) {
      if (!e || !e.usage) return '';
      return '已占用约 ' + (e.usage / 1048576).toFixed(1) + ' MB';
    }).catch(function () { return ''; });
  }

  // —— UI ——
  function injectStyle() {
    if ($('#dl-style')) return;
    var st = document.createElement('style');
    st.id = 'dl-style';
    st.textContent =
      '.dl-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:2147482400;display:flex;align-items:flex-end;justify-content:center;animation:dl-fade .2s ease both}' +
      '@media(min-width:560px){.dl-backdrop{align-items:center}}' +
      '.dl-panel{background:var(--paper,#f6f1e6);color:var(--ink,#322a1e);width:min(34rem,100%);max-height:86vh;display:flex;flex-direction:column;border-radius:16px 16px 0 0;box-shadow:0 -8px 44px rgba(0,0,0,.28);font-family:var(--serif,serif);animation:dl-up .26s ease both}' +
      '@media(min-width:560px){.dl-panel{border-radius:16px}}' +
      '.dl-head{display:flex;align-items:center;gap:.6rem;padding:1rem 1.1rem .5rem}' +
      '.dl-head h2{font-size:1.06rem;margin:0;flex:1;font-weight:700}' +
      '.dl-x{border:0;background:transparent;color:inherit;opacity:.5;font-size:1.25rem;line-height:1;cursor:pointer;padding:.2rem .4rem}' +
      '.dl-intro{padding:0 1.1rem .4rem;font-size:.8rem;opacity:.7;line-height:1.55}' +
      '.dl-list{overflow:auto;padding:.1rem .5rem .2rem}' +
      '.dl-row{display:flex;align-items:center;gap:.7rem;padding:.72rem .6rem;border-top:1px solid var(--line,#d9cdb2)}' +
      '.dl-row:first-child{border-top:0}' +
      '.dl-row.all{font-weight:600}' +
      '.dl-nm{flex:1;min-width:0}' +
      '.dl-sub{display:block;font-size:.74rem;opacity:.55;margin-top:.12rem;font-weight:400}' +
      '.dl-btn{flex:0 0 auto;border:1px solid var(--cinnabar,#b03a26);background:transparent;color:var(--cinnabar,#b03a26);border-radius:8px;font-family:inherit;font-size:.82rem;padding:.34rem .8rem;cursor:pointer;white-space:nowrap}' +
      '.dl-btn.primary{background:var(--cinnabar,#b03a26);color:var(--paper,#f6f1e6)}' +
      '.dl-btn:disabled{opacity:.45;cursor:default}' +
      '.dl-ok{flex:0 0 auto;display:flex;align-items:center;gap:.6rem;color:var(--cinnabar,#b03a26);font-size:.82rem;white-space:nowrap}' +
      '.dl-clear{border:0;background:transparent;color:var(--ink,#322a1e);opacity:.5;font-size:.76rem;text-decoration:underline;cursor:pointer;padding:0}' +
      '.dl-prog{padding:.5rem 1.1rem .2rem}' +
      '.dl-prog-txt{font-size:.78rem;display:flex;justify-content:space-between;margin-bottom:.32rem}' +
      '.dl-bar{height:6px;border-radius:3px;background:var(--cinnabar-soft,rgba(176,58,38,.12));overflow:hidden}' +
      '.dl-bar>i{display:block;height:100%;width:0;background:var(--cinnabar,#b03a26);transition:width .15s}' +
      '.dl-foot{padding:.55rem 1.1rem 1.1rem;padding-bottom:calc(1.1rem + env(safe-area-inset-bottom,0));font-size:.73rem;opacity:.6;line-height:1.5;border-top:1px solid var(--line,#d9cdb2)}' +
      '@keyframes dl-fade{from{opacity:0}to{opacity:1}}@keyframes dl-up{from{transform:translateY(100%)}to{transform:translateY(0)}}';
    document.head.appendChild(st);
  }

  function refreshOpenBtn() {
    var b = $('#offline-open'); if (!b) return;
    if (active) { b.textContent = '下载中…'; return; }
    var s = getState();
    b.textContent = Object.keys(s).length ? '管理离线' : '下载整册';
  }

  function close() {
    var bd = $('#dl-backdrop'); if (bd) bd.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function open() {
    if ($('#dl-backdrop')) return;
    injectStyle();
    var bd = document.createElement('div');
    bd.className = 'dl-backdrop'; bd.id = 'dl-backdrop';
    bd.innerHTML =
      '<div class="dl-panel" role="dialog" aria-label="离线下载" aria-modal="true">' +
      '<div class="dl-head"><h2>离线下载</h2><button class="dl-x" aria-label="关闭">✕</button></div>' +
      '<p class="dl-intro">下载后断网也能阅读，启动更快。注释随正文一并保存；全文检索需联网，篇名搜索离线可用。</p>' +
      '<div class="dl-prog" id="dl-prog" hidden><div class="dl-prog-txt"><span id="dl-prog-label"></span><button class="dl-clear" id="dl-cancel">取消</button></div><div class="dl-bar"><i id="dl-bar-i"></i></div></div>' +
      '<div class="dl-intro"><span id="dl-version" role="status" aria-live="polite"></span> <button class="dl-clear" id="dl-check">检查文本更新</button></div>' +
      '<div class="dl-list" id="dl-list"></div>' +
      '<div class="dl-intro" id="dl-notice" role="status" aria-live="polite"></div>' +
      '<div class="dl-foot" id="dl-foot"></div>' +
      '</div>';
    document.body.appendChild(bd);
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    $('.dl-x', bd).onclick = close;
    document.addEventListener('keydown', onKey);
    $('#dl-cancel', bd).onclick = function () {
      cancelFlag = true;
      if (active) active.controllers.forEach(function (c) { c.abort(); });
    };
    $('#dl-check', bd).onclick = checkUpdates;
    checkUpdates();
  }

  async function checkUpdates() {
    if (active || checking) { renderList(); return; }
    checking = true; renderList();
    var version = $('#dl-version'); if (version) version.textContent = '正在检查文本版本…';
    try { await loadCatalog(); await inspectLocal(); }
    catch (err) {
      catalogError = '目录加载失败，请联网后重试。';
      var list = $('#dl-list'); if (list) list.textContent = catalogError;
    }
    checking = false; renderList(); refreshOpenBtn();
  }
  function renderList() {
    var list = $('#dl-list'); if (!list) return;
    var check = $('#dl-check'); if (check) check.disabled = !!active || checking;
    var version = $('#dl-version');
    if (version && !checking) version.textContent = MANIFEST ?
      ((catalogOnline ? '线上文本版本：' : '上次检查版本：') + MANIFEST.version + '。' + catalogError) :
      (catalogError || '联网后可核对文本版本。');
    if (!BOOKS) return;
    var state = getState();
    list.innerHTML = '';
    BOOKS.forEach(function (bk) {
      var row = document.createElement('div'), status = STATUS[bk.id] || { present: 0, current: 0, pending: bk.count };
      row.className = 'dl-row' + (bk.id === '__all__' ? ' all' : '');
      var allSaved = status.present === bk.count, latest = MANIFEST && status.current === bk.count;
      var savedVersion = state[bk.id] && state[bk.id].version;
      var detail = bk.count + ' 篇';
      if (status.present) detail += ' · 已存 ' + status.present + ' 篇';
      if (latest) detail += catalogOnline ? ' · 文本已最新' : ' · 与上次版本一致';
      else if (status.present && MANIFEST) detail += ' · 待更新或补齐 ' + status.pending + ' 篇';
      else if (status.present) detail += ' · 版本待核对';
      if (savedVersion && allSaved && !latest) detail += ' · 已保存版本 ' + savedVersion;
      row.innerHTML = '<span class="dl-nm"><b>' + esc(bk.name) + '</b><span class="dl-sub">' + esc(detail) + '</span></span>';
      var act = document.createElement('span'); act.className = 'dl-ok';
      if (!latest) {
        var btn = document.createElement('button');
        btn.className = 'dl-btn' + (bk.id === '__all__' ? ' primary' : '');
        btn.textContent = status.present ? (allSaved ? '更新' : '补齐 / 更新') : '下载';
        btn.disabled = !!active || checking || !MANIFEST;
        btn.onclick = function () { doDownload(bk); };
        act.appendChild(btn);
      } else { var tick = document.createElement('span'); tick.textContent = '✓'; tick.setAttribute('aria-label', '已离线'); act.appendChild(tick); }
      if (status.present) {
        var clr = document.createElement('button');
        clr.className = 'dl-clear'; clr.textContent = '清除'; clr.disabled = !!active || checking;
        clr.onclick = function () { doClear(bk); }; act.appendChild(clr);
      }
      row.appendChild(act); list.appendChild(row);
    });
    refreshFoot();
  }

  function refreshFoot() {
    usageText().then(function (t) {
      var f = $('#dl-foot'); if (f) f.textContent = t ? (t + '；可随时清除，不占应用商店空间。') : '下载内容存于本设备，可随时清除。';
    });
  }

  function setProgress(label, done, total) {
    var p = $('#dl-prog'); if (!p) return;
    if (done == null) { p.hidden = true; return; }
    p.hidden = false;
    $('#dl-prog-label').textContent = label;
    $('#dl-bar-i').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
  }

  async function doDownload(bk) {
    if (active || checking || !MANIFEST) return;
    active = { scope: bk.id, controllers: [] };
    refreshOpenBtn(); renderList();
    setProgress('正在核对与下载「' + bk.name + '」 0 / ' + bk.count, 0, bk.count);
    try {
      var r = await downloadUrls(bk.ids, function (done, total) {
        setProgress('正在核对与下载「' + bk.name + '」 ' + done + ' / ' + total, done, total);
      });
      await inspectLocal();
      // 以实际缓存为准，包含浏览器驱逐、失败和取消后的真实状态。
      var st = STATUS[bk.id];
      var complete = !r.cancelled && !r.quotaHit && !r.aborted && r.failed === 0 && r.ok === bk.count && st.current === bk.count;
      if (complete) {
        mark(bk.id, true);
        if (bk.id === '__all__') BOOKS.forEach(function (b) { mark(b.id, true); });
      }
      if (r.quotaHit) notice('存储空间不足，已保留 ' + st.present + ' / ' + bk.count + ' 篇；旧文本仍可阅读。清理空间后可继续更新。');
      else if (r.cancelled) notice('已取消，已保存的文本仍可阅读；再次操作可继续。');
      else if (!complete) notice('更新尚未完成，已保留 ' + st.present + ' / ' + bk.count + ' 篇，待更新或补齐 ' + st.pending + ' 篇。联网后可重试。');
      else notice('「' + bk.name + '」已保存 ' + bk.count + ' 篇，本次更新 ' + r.updated + ' 篇。');
    } catch (err) { notice('无法保存离线文本，已存内容仍保留。请检查设备存储空间后重试。'); }
    finally { active = null; setProgress(null); refreshOpenBtn(); renderList(); }
  }

  // 轻量提示条：优先复用站内 toast，未就绪则退化为面板内文字
  // 注：app.js 的 toast 是脚本顶层函数（未挂 window），故用 typeof 直接探全局标识符；
  // 写成 window.toast 在这里永远取不到。
  function notice(msg) {
    var n = $('#dl-notice'); if (n) n.textContent = msg;
    try {
      if (typeof toast === 'function') { toast(msg); return; }
    } catch (e) {}
    if (!n) { var f = $('#dl-foot'); if (f) f.textContent = msg; }
  }

  async function doClear(bk) {
    if (active || checking) return;
    checking = true; renderList();
    try {
      await clearUrls(urlsFor(bk.ids));
      if (bk.id === '__all__') { setState({}); }
      else { mark(bk.id, false); mark('__all__', false); }
      await inspectLocal();
    } catch (err) { notice('清除未完成，请稍后重试。'); }
    finally { checking = false; refreshOpenBtn(); renderList(); }
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // —— 入口 ——
  function wire() {
    var b = $('#offline-open');
    if (b && !b._wired) { b._wired = true; b.addEventListener('click', open); refreshOpenBtn(); }
  }
  if (document.readyState !== 'loading') wire();
  else document.addEventListener('DOMContentLoaded', wire);
  window.__wcOfflineWire = wire;   // 「我的」页动态渲染离线按钮后由 app.js 调用重新挂载（wire 内有 _wired 幂等保护）
})();
