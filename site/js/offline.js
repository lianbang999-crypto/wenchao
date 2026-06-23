/* 整册离线下载。
   把整册 / 全集的 data/articles/{id}.json 预存进独立缓存 wc-dl；
   断网时 sw.js 的「网络失败 → caches.match」会自动跨 cache 命中，无需改 app.js。
   注释内嵌在每篇 JSON 内，故离线阅读只需缓存这些文件 + 已在外壳里的 books.json。
   全文搜索(search.json 15MB)默认不下载，离线时篇名搜索仍可用。 */
(function () {
  'use strict';

  var DL = 'wc-dl';
  var LS = 'wc-dl-state';        // { "bookId"|"__all__": 完成时间戳 }
  var CONC = 6;                  // 并发数
  var BOOKS = null;             // [{id,name,ids:[],count}]，含合成的 __all__
  var active = null;            // 进行中的下载 {scope}
  var cancelFlag = false;

  var $ = function (s, r) { return (r || document).querySelector(s); };

  if (!('caches' in window)) {
    // 浏览器不支持 CacheStorage：禁用入口
    document.addEventListener('DOMContentLoaded', function () {
      var b = $('#offline-open'); if (b) { b.disabled = true; b.title = '当前浏览器不支持离线缓存'; }
    });
    return;
  }

  // —— 状态持久化 ——
  function getState() { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; } }
  function setState(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch (e) {} }
  function mark(scope, on) { var s = getState(); if (on) s[scope] = Date.now(); else delete s[scope]; setState(s); }

  // —— 数据 ——
  function idsOfBook(book) {
    var ids = [];
    (book.juans || []).forEach(function (j) {
      (j.cats || []).forEach(function (c) {
        (c.items || []).forEach(function (it) { if (it && it.id) ids.push(it.id); });
      });
    });
    return ids;
  }
  function urlsFor(ids) { return ids.map(function (id) { return '/data/articles/' + id + '.json'; }); }

  function loadBooks() {
    if (BOOKS) return Promise.resolve(BOOKS);
    return fetch('/data/books.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (list) {
      var all = [];
      var books = list.map(function (b) {
        var ids = idsOfBook(b); all = all.concat(ids);
        return { id: b.id, name: b.name, ids: ids, count: ids.length };
      });
      BOOKS = [{ id: '__all__', name: '全部文钞', ids: all, count: all.length }].concat(books);
      return BOOKS;
    });
  }

  // —— 下载 / 清除 ——
  function downloadUrls(urls, onProgress) {
    cancelFlag = false;
    return caches.open(DL).then(function (cache) {
      var i = 0, done = 0, ok = 0, failed = 0;
      function worker() {
        if (i >= urls.length || cancelFlag) return Promise.resolve();
        var u = urls[i++];
        return cache.match(u).then(function (hit) {
          if (hit) { ok++; return; }
          return fetch(u, { cache: 'no-store' }).then(function (res) {
            if (res && res.ok) { ok++; return cache.put(u, res.clone()); }
            failed++;
          });
        }).catch(function () { failed++; }).then(function () {
          done++; if (onProgress) onProgress(done, urls.length);
          return worker();
        });
      }
      var ws = []; for (var k = 0; k < CONC; k++) ws.push(worker());
      return Promise.all(ws).then(function () { return { done: done, ok: ok, failed: failed, cancelled: cancelFlag }; });
    });
  }
  function clearUrls(urls) {
    return caches.open(DL).then(function (cache) {
      return Promise.all(urls.map(function (u) { return cache.delete(u); }));
    });
  }
  function clearAll() { return caches.delete(DL); }

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
      '<div class="dl-list" id="dl-list"></div>' +
      '<div class="dl-foot" id="dl-foot"></div>' +
      '</div>';
    document.body.appendChild(bd);
    bd.addEventListener('click', function (e) { if (e.target === bd) close(); });
    $('.dl-x', bd).onclick = close;
    document.addEventListener('keydown', onKey);
    $('#dl-cancel', bd).onclick = function () { cancelFlag = true; };
    loadBooks().then(renderList).catch(function () {
      $('#dl-list').innerHTML = '<div class="dl-row">目录加载失败，请联网后重试。</div>';
    });
  }

  function renderList() {
    var list = $('#dl-list'); if (!list) return;
    var state = getState();
    list.innerHTML = '';
    BOOKS.forEach(function (bk) {
      var row = document.createElement('div');
      row.className = 'dl-row' + (bk.id === '__all__' ? ' all' : '');
      var done = !!state[bk.id];
      row.innerHTML =
        '<span class="dl-nm"><b>' + esc(bk.name) + '</b>' +
        '<span class="dl-sub">' + bk.count + ' 篇' + (done ? ' · 已离线' : '') + '</span></span>';
      var act = document.createElement('span');
      if (done) {
        act.className = 'dl-ok';
        act.innerHTML = '<span aria-hidden="true">✓</span>';
        var clr = document.createElement('button');
        clr.className = 'dl-clear'; clr.textContent = '清除';
        clr.onclick = function () { doClear(bk); };
        act.appendChild(clr);
      } else {
        var btn = document.createElement('button');
        btn.className = 'dl-btn' + (bk.id === '__all__' ? ' primary' : '');
        btn.textContent = '下载';
        btn.disabled = !!active;
        btn.onclick = function () { doDownload(bk); };
        act = btn;
      }
      row.appendChild(act);
      list.appendChild(row);
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

  function doDownload(bk) {
    if (active) return;
    active = { scope: bk.id };
    refreshOpenBtn();
    // 下载期间禁用其它下载按钮
    Array.prototype.forEach.call(document.querySelectorAll('#dl-list .dl-btn'), function (b) { b.disabled = true; });
    setProgress('正在下载「' + bk.name + '」 0 / ' + bk.count, 0, bk.count);
    downloadUrls(urlsFor(bk.ids), function (done, total) {
      setProgress('正在下载「' + bk.name + '」 ' + done + ' / ' + total, done, total);
    }).then(function (r) {
      if (!r.cancelled) {
        mark(bk.id, true);
        if (bk.id === '__all__') BOOKS.forEach(function (b) { if (b.id !== '__all__') mark(b.id, true); });
      }
      active = null; setProgress(null);
      refreshOpenBtn(); renderList();
    });
  }

  function doClear(bk) {
    if (active) return;
    clearUrls(urlsFor(bk.ids)).then(function () {
      if (bk.id === '__all__') {
        return clearAll().then(function () { setState({}); });
      }
      mark(bk.id, false); mark('__all__', false);
    }).then(function () { refreshOpenBtn(); renderList(); });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // —— 入口 ——
  function wire() {
    var b = $('#offline-open');
    if (b && !b._wired) { b._wired = true; b.addEventListener('click', open); refreshOpenBtn(); }
  }
  if (document.readyState !== 'loading') wire();
  else document.addEventListener('DOMContentLoaded', wire);
})();
