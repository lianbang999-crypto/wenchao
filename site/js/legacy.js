/* Android 4.4 基础阅读：ES5、XHR 与本地存储，无在线服务依赖。 */
(function () {
  'use strict';

  var reader = document.getElementById('legacy-reader');
  var books = [], flat = [], articlesById = Object.create(null);
  var current = null, pendingRequest = null, routeRevision = 0;
  var mode = 'both', textSize = 17, volumeId = '', keyword = '', resultPage = 0;
  var pageSize = 60, cacheLimit = 6, articleCache = Object.create(null), cacheOrder = [];
  var scrollTimer = null, ready = false, restoring = false;
  var articleHash = '', readingPosition = null;

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isArray(value) { return Object.prototype.toString.call(value) === '[object Array]'; }
  function textList(value) { return value == null ? [] : (isArray(value) ? value : [value]); }
  function finite(value) { return typeof value === 'number' && isFinite(value); }
  function save(key, value) {
    try { localStorage.setItem('wc.legacy.' + key, JSON.stringify(value)); return true; }
    catch (e) {
      $('legacy-storage-warning').innerHTML = '阅读记录未能保存。本机存储空间可能不足，退出前请记下篇名和位置。';
      return false;
    }
  }
  function load(key, fallback) {
    try {
      var value = JSON.parse(localStorage.getItem('wc.legacy.' + key));
      return value == null ? fallback : value;
    } catch (e) { return fallback; }
  }
  function xhrJson(url, done) {
    var xhr = new XMLHttpRequest(), settled = false;
    function finish(err, value) {
      if (settled) return;
      settled = true;
      done(err, value);
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 0) {
        var data;
        try { data = JSON.parse(xhr.responseText); }
        catch (e) { finish(e); return; }
        finish(null, data);
      } else finish(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = function () { finish(new Error('无法读取文件')); };
    try {
      xhr.open('GET', url, true);
      xhr.timeout = 15000;
      xhr.send(null);
    } catch (e) { finish(e); }
    return xhr;
  }
  function flatten() {
    var i, j, k, n, vol, juan, cat, item, row;
    for (i = 0; i < books.length; i += 1) {
      vol = books[i];
      for (j = 0; j < vol.juans.length; j += 1) {
        juan = vol.juans[j];
        for (k = 0; k < juan.cats.length; k += 1) {
          cat = juan.cats[k];
          for (n = 0; n < cat.items.length; n += 1) {
            item = cat.items[n];
            row = { id: item.id, title: item.title, volume: vol.id,
              volumeName: vol.name, juan: juan.name, index: flat.length };
            flat.push(row);
            articlesById[row.id] = row;
          }
        }
      }
    }
  }
  function scrollY() { return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0; }
  function scrollRange() {
    return Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) -
      (window.innerHeight || document.documentElement.clientHeight));
  }
  function position() {
    var y = scrollY(), range = scrollRange();
    return { y: y, ratio: range > 0 ? Math.min(1, y / range) : 0, mode: mode, size: textSize };
  }
  function savePosition() {
    if (scrollTimer !== null) { window.clearTimeout(scrollTimer); scrollTimer = null; }
    if (!current || restoring) return;
    // Hash navigation may scroll before hashchange. Never assign that new viewport
    // to the departing article; retain its most recent reading coordinates.
    if (location.hash === articleHash) readingPosition = position();
    if (readingPosition) save('position.' + current.id, readingPosition);
  }
  function restorePosition(saved, relative) {
    var y = 0;
    if (finite(saved)) y = saved; // Accept positions saved by the first compatibility build.
    else if (saved && finite(saved.y)) {
      y = saved.y;
      if ((relative || saved.mode !== mode || saved.size !== textSize) && finite(saved.ratio))
        y = Math.max(0, Math.min(1, saved.ratio)) * scrollRange();
    }
    window.scrollTo(0, Math.max(0, Math.min(y, scrollRange())));
  }
  function setReader(html) { reader.innerHTML = html; window.scrollTo(0, 0); }
  function navigate(hash) {
    if (location.hash !== hash) {
      savePosition(); // Capture before the browser moves the viewport for the new hash.
      location.hash = hash;
    }
    else if (!current) route();
  }
  function openArticle(id) { if (articlesById[id]) navigate('#article=' + encodeURIComponent(id)); }
  function renderHome() {
    var last = load('last', null), resume = '', html = '', options = '', i, j, count, vol;
    if (last && articlesById[last.id]) resume = '<p class="legacy-home-actions"><button class="legacy-action" id="legacy-resume" type="button">继续阅读：' + esc(articlesById[last.id].title) + '</button></p>';
    setReader('<section class="legacy-hero"><h1>印光法师文钞</h1><p>文白对照 · 离线基础阅读</p></section>' +
      '<p class="legacy-note">保留目录检索、文白对照、注释和阅读进度。全部正文随安装包提供，可离线阅读。</p>' + resume +
      '<section class="legacy-section"><h2>选择文集</h2><div id="legacy-volumes"></div></section>' +
      '<section class="legacy-section" id="legacy-catalog"><h2>篇目目录</h2><div class="legacy-tools"><label for="legacy-search">搜索篇名</label>' +
      '<input id="legacy-search" type="search" placeholder="输入篇名关键词"><label for="legacy-volume">文集范围</label>' +
      '<select id="legacy-volume"></select></div><div id="legacy-results" aria-live="polite"></div></section>');
    options = '<option value="">全部文集</option>';
    for (i = 0; i < books.length; i += 1) {
      vol = books[i]; count = 0;
      for (j = 0; j < flat.length; j += 1) if (flat[j].volume === vol.id) count += 1;
      html += '<button class="legacy-volume" data-vol="' + esc(vol.id) + '" type="button"><strong>' + esc(vol.name) + '</strong><small>' + esc(vol.group || '') + ' · ' + count + ' 篇</small></button>';
      options += '<option value="' + esc(vol.id) + '">' + esc(vol.name) + '</option>';
    }
    $('legacy-volumes').innerHTML = html;
    $('legacy-volume').innerHTML = options;
    $('legacy-volume').value = volumeId;
    $('legacy-search').value = keyword;
    $('legacy-volumes').onclick = function (event) {
      var button = actionTarget(event, 'data-vol');
      if (!button) return;
      volumeId = button.getAttribute('data-vol'); keyword = ''; resultPage = 0;
      $('legacy-volume').value = volumeId; $('legacy-search').value = '';
      renderResults(); $('legacy-catalog').scrollIntoView();
    };
    if ($('legacy-resume')) $('legacy-resume').onclick = function () { openArticle(last.id); };
    $('legacy-search').oninput = function () { keyword = this.value; resultPage = 0; renderResults(); };
    $('legacy-volume').onchange = function () { volumeId = this.value; resultPage = 0; renderResults(); };
    renderResults();
  }
  function actionTarget(event, attribute) {
    var target = (event || window.event).target || (event || window.event).srcElement;
    while (target && target !== reader) {
      if (target.getAttribute && target.getAttribute(attribute) !== null) return target;
      target = target.parentNode;
    }
    return null;
  }
  function renderResults() {
    var q = String(keyword).replace(/^\s+|\s+$/g, ''), hits = [], i, item, html, pages, start, end;
    for (i = 0; i < flat.length; i += 1) {
      item = flat[i];
      if ((!volumeId || item.volume === volumeId) && (!q || item.title.indexOf(q) >= 0)) hits.push(item);
    }
    if (!hits.length) {
      $('legacy-results').innerHTML = '<p class="legacy-nopair">没有找到篇名。可以换一个关键词。</p>';
      return;
    }
    pages = Math.ceil(hits.length / pageSize);
    resultPage = Math.max(0, Math.min(resultPage, pages - 1));
    start = resultPage * pageSize; end = Math.min(start + pageSize, hits.length);
    html = '<p class="legacy-result-count">共 ' + hits.length + ' 篇 · 第 ' + (start + 1) + '—' + end + ' 篇</p><ul class="legacy-list">';
    for (i = start; i < end; i += 1) html += '<li><button type="button" data-id="' + esc(hits[i].id) + '">' + esc(hits[i].title) + '<br><small>' + esc(hits[i].volumeName) + ' · ' + esc(hits[i].juan) + '</small></button></li>';
    html += '</ul><div class="legacy-pagination">';
    if (resultPage > 0) html += '<button class="legacy-action" type="button" data-page="' + (resultPage - 1) + '">上一页</button>';
    html += '<label for="legacy-page">第 <select id="legacy-page" aria-label="目录页码">';
    for (i = 0; i < pages; i += 1) html += '<option value="' + i + '"' + (i === resultPage ? ' selected' : '') + '>' + (i + 1) + '</option>';
    html += '</select> / ' + pages + ' 页</label>';
    if (resultPage + 1 < pages) html += '<button class="legacy-action" type="button" data-page="' + (resultPage + 1) + '">下一页</button>';
    $('legacy-results').innerHTML = html + '</div>';
    $('legacy-results').onclick = function (event) {
      var itemButton = actionTarget(event, 'data-id'), pageButton = actionTarget(event, 'data-page');
      if (itemButton) openArticle(itemButton.getAttribute('data-id'));
      else if (pageButton) {
        resultPage = Number(pageButton.getAttribute('data-page'));
        renderResults(); $('legacy-results').scrollIntoView();
      }
    };
    $('legacy-page').onchange = function () {
      resultPage = Number(this.value); renderResults(); $('legacy-results').scrollIntoView();
    };
  }
  function hasTranslation(art) {
    var i;
    for (i = 0; i < art.segments.length; i += 1) if (textList(art.segments[i].trans).length) return true;
    return false;
  }
  function renderParagraphs(list, className) {
    var html = '', i;
    for (i = 0; i < list.length; i += 1) html += '<p class="' + className + '">' + esc(list[i]) + '</p>';
    return html;
  }
  function renderNotes(notes) {
    var html = '', i, note;
    if (!notes || !notes.length) return '';
    for (i = 0; i < notes.length; i += 1) {
      note = notes[i];
      html += '<li><b>注' + esc(note.n) + (note.term ? ' · ' + esc(note.term) : '') + '</b><p>' + esc(note.text) + '</p></li>';
    }
    return '<div class="legacy-notes"><h3>本段注释</h3><ul>' + html + '</ul></div>';
  }
  function renderSegments(art, displayMode) {
    var html = '', i, j, seg, orig, trans;
    for (i = 0; i < art.segments.length; i += 1) {
      seg = art.segments[i] || {}; orig = textList(seg.orig); trans = textList(seg.trans);
      html += '<section class="legacy-segment">';
      if (displayMode === 'both' && orig.length && orig.length === trans.length) {
        for (j = 0; j < orig.length; j += 1) html += '<div class="legacy-block legacy-pair"><h3>原文</h3>' + renderParagraphs([orig[j]], 'legacy-original') + '<h3>白话</h3>' + renderParagraphs([trans[j]], 'legacy-translation') + '</div>';
      } else {
        if ((displayMode !== 'trans' || !trans.length) && orig.length)
          html += '<div class="legacy-block"><h3>原文</h3>' + renderParagraphs(orig, 'legacy-original') + '</div>';
        if (displayMode !== 'orig' && trans.length)
          html += '<div class="legacy-block"><h3>白话</h3>' + renderParagraphs(trans, 'legacy-translation') + '</div>';
        if (displayMode === 'trans' && orig.length && !trans.length)
          html += '<p class="legacy-nopair">本段未附白话，显示原文。</p>';
      }
      html += renderNotes(seg.notes) + '</section>';
    }
    return html || '<p class="legacy-nopair">本篇暂未提供可显示的正文。</p>';
  }
  function renderArticle(art, saved, relative) {
    var hasTrans = hasTranslation(art), displayMode = hasTrans ? mode : 'orig';
    var item = articlesById[art.id], previous = flat[item.index - 1], next = flat[item.index + 1];
    var controls = '<div class="legacy-mode"><button type="button" data-mode="orig"' + (displayMode === 'orig' ? ' class="active"' : '') + '>原文</button>';
    if (hasTrans) controls += '<button type="button" data-mode="trans"' + (displayMode === 'trans' ? ' class="active"' : '') + '>白话</button><button type="button" data-mode="both"' + (displayMode === 'both' ? ' class="active"' : '') + '>对照</button>';
    controls += '<button type="button" id="legacy-smaller"' + (textSize <= 14 ? ' disabled' : '') + '>小字</button><button type="button" id="legacy-larger"' + (textSize >= 28 ? ' disabled' : '') + '>大字</button></div>';
    var pager = '<div class="legacy-pager">';
    if (previous) pager += '<button class="legacy-action" type="button" data-id="' + esc(previous.id) + '">上一篇：' + esc(previous.title) + '</button>';
    if (next) pager += '<button class="legacy-action" type="button" data-id="' + esc(next.id) + '">下一篇：' + esc(next.title) + '</button>';
    pager += '<button class="legacy-action" id="legacy-back" type="button">返回目录</button></div>';
    restoring = true;
    setReader('<article class="legacy-article"><div class="legacy-crumb">' + esc(art.volumeName || item.volumeName) + ' · ' + esc(art.juan || item.juan) + '</div><h1>' + esc(art.title || item.title) + '</h1>' +
      (art.translator ? '<p class="legacy-credits">' + esc(art.translator) + '</p>' : '') +
      (art.summary ? '<p class="legacy-summary"><b>提要</b>' + esc(art.summary) + '</p>' : '') + controls +
      (!hasTrans ? '<p class="legacy-nopair">本篇未附白话，显示原文。</p>' : '') +
      '<div id="legacy-body" style="font-size:' + textSize + 'px">' + renderSegments(art, displayMode) + '</div>' + pager + '</article>');
    current = art;
    articleHash = location.hash;
    document.title = (art.title || item.title) + ' · 印光法师文钞';
    reader.onclick = function (event) {
      var modeButton = actionTarget(event, 'data-mode'), itemButton = actionTarget(event, 'data-id'), savedPosition;
      if (modeButton) {
        savedPosition = position(); mode = modeButton.getAttribute('data-mode'); save('mode', mode);
        renderArticle(art, savedPosition, true);
      } else if (itemButton) openArticle(itemButton.getAttribute('data-id'));
    };
    $('legacy-smaller').onclick = function () { changeSize(-1); };
    $('legacy-larger').onclick = function () { changeSize(1); };
    $('legacy-back').onclick = function () { navigate(''); };
    restorePosition(saved, relative);
    readingPosition = position();
    restoring = false;
    save('last', { id: art.id, title: art.title || item.title });
    function changeSize(delta) {
      var savedPosition = position(); textSize = Math.max(14, Math.min(28, textSize + delta));
      save('size', textSize); renderArticle(art, savedPosition, true);
    }
  }
  function remember(art) {
    var i;
    for (i = cacheOrder.length - 1; i >= 0; i -= 1) if (cacheOrder[i] === art.id) cacheOrder.splice(i, 1);
    articleCache[art.id] = art; cacheOrder.push(art.id);
    while (cacheOrder.length > cacheLimit) delete articleCache[cacheOrder.shift()];
  }
  function route() {
    if (!ready) return;
    savePosition(); current = null; reader.onclick = null;
    routeRevision += 1;
    if (pendingRequest) { pendingRequest.abort(); pendingRequest = null; }
    var revision = routeRevision, match = (location.hash || '').match(/^#article=(.+)$/), id = '';
    if (match) { try { id = decodeURIComponent(match[1]); } catch (e) {} }
    if (!match) { document.title = '印光法师文钞 · 基础阅读'; renderHome(); return; }
    if (!articlesById[id]) { showArticleError('目录中没有找到这一篇。'); return; }
    if (articleCache[id]) { remember(articleCache[id]); renderArticle(articleCache[id], load('position.' + id, 0), false); return; }
    setReader('<p class="legacy-loading">正在打开这一篇……</p>');
    pendingRequest = xhrJson('/data/articles/' + encodeURIComponent(id) + '.json', function (err, art) {
      if (revision !== routeRevision) return;
      pendingRequest = null;
      if (err || !art || art.id !== id || !isArray(art.segments)) { showArticleError('这篇文章暂时无法打开，请返回目录重试。'); return; }
      remember(art); renderArticle(art, load('position.' + id, 0), false);
    });
  }
  function showArticleError(message) {
    setReader('<p class="legacy-error">' + esc(message) + '</p><button class="legacy-action" id="legacy-error-back" type="button">返回目录</button>');
    $('legacy-error-back').onclick = function () { navigate(''); };
  }
  window.onscroll = function () {
    if (!current || restoring || location.hash !== articleHash) return;
    readingPosition = position(); // Keep a synchronous snapshot for device Back navigation.
    if (scrollTimer !== null) window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(savePosition, 250);
  };
  window.onhashchange = route;
  window.addEventListener('pagehide', savePosition, false);
  document.addEventListener('visibilitychange', function () { if (document.hidden) savePosition(); }, false);
  $('legacy-home').onclick = function () { navigate(''); };
  textSize = load('size', 17);
  if (!finite(textSize)) textSize = 17;
  textSize = Math.max(14, Math.min(28, Math.round(textSize)));
  mode = load('mode', 'both');
  if (mode !== 'orig' && mode !== 'trans' && mode !== 'both') mode = 'both';
  xhrJson('/data/books.json', function (err, data) {
    if (err || !isArray(data) || !data.length) { setReader('<p class="legacy-error">目录载入失败，请重新打开应用。</p>'); return; }
    books = data; flatten(); ready = true; route();
  });
}());
