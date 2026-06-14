/* 分享：选段 → 底部操作条 → 生成「素简阅读卡」(高度自适应) + 二维码 → 长按转发/保存。
   设计要点（专治上次手机/微信里复制·分享全失灵）：
   - 选段用 selectionchange（触屏安全），选中文字即时存档，防点按钮时选区被清空；
   - 操作入口是屏幕底部固定条，不做浮在选区上的小气泡（手机定位易飘出屏外）；
   - 转发卡片靠「长按图片」——微信原生能力，零 Web API，最可靠；
   - 复制 navigator.clipboard 优先、execCommand 兜底；navigator.share 仅在支持时锦上添花。
   依赖：window.qrcode（qrcode.js，本地离线）、window.WENCHAO_CONFIG。 */
(function () {
  'use strict';
  var CFG = window.WENCHAO_CONFIG || {};
  var MAX = CFG.shareMaxChars || 800;
  var SERIF = '"Noto Serif SC","Songti SC","STSong","Source Han Serif SC",serif';

  var picked = null;     // { text, id, title, pIndex }
  var lastBlob = null, lastUrl = '', lastText = '';

  function $(s, r) { return (r || document).querySelector(s); }
  function reader() { return document.getElementById('reader'); }
  function clen(s) { return s.replace(/\s/g, '').length; }   // 字数（忽略空白）

  function curId() {
    var m = (location.hash || '').match(/^#\/a\/([\w-]+)/);
    return m ? m[1] : '';
  }
  function curTitle() {
    var h = $('.art-title');
    return h ? h.textContent.trim() : '印光法师文钞';
  }
  function shareUrl(id, p) {
    var base = CFG.shareBase || (location.origin + location.pathname);
    base = base.replace(/[#?].*$/, '').replace(/\/+$/, '');
    return base + '/#/a/' + id + (p != null ? '?p=' + p : '');
  }
  // 选区起点所在段落在 .art-body 内的序号（深链定位用，与 app.js scrollToPara 同口径）
  function paraIndexOf(node) {
    var body = $('.art-body', reader());
    if (!body || !node) return null;
    var el = node.nodeType === 1 ? node : node.parentElement;
    var p = el && el.closest ? el.closest('p.p-orig, p.p-trans') : null;
    if (!p) return null;
    var ps = body.querySelectorAll('p.p-orig, p.p-trans');
    for (var i = 0; i < ps.length; i++) if (ps[i] === p) return i;
    return null;
  }

  /* ---------- 底部操作条 ---------- */
  var bar, barCount;
  function ensureBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'share-bar';
    bar.hidden = true;
    bar.innerHTML =
      '<span class="sb-count"></span>' +
      '<button class="sb-make" type="button">制作分享卡</button>' +
      '<button class="sb-x" type="button" aria-label="取消">×</button>';
    document.body.appendChild(bar);
    barCount = $('.sb-count', bar);
    $('.sb-make', bar).addEventListener('click', openCard);
    $('.sb-x', bar).addEventListener('click', hideBar);
  }
  function showBar() { ensureBar(); bar.hidden = false; }
  function hideBar() { if (bar) bar.hidden = true; }

  /* ---------- 选区监听 ---------- */
  var timer;
  function onSelChange() { clearTimeout(timer); timer = setTimeout(evalSelection, 180); }
  function evalSelection() {
    if (!/^#\/a\//.test(location.hash || '')) { hideBar(); return; }   // 仅在阅读页
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideBar(); return; }
    var text = sel.toString();
    if (!text || !clen(text)) { hideBar(); return; }
    var body = $('.art-body', reader());
    if (!body || (!body.contains(sel.anchorNode) && !body.contains(sel.focusNode))) { hideBar(); return; }
    var n = clen(text);
    var meta = window.__wcShare || {};
    picked = {
      text: text, id: curId(),
      title: meta.title || curTitle(), book: meta.book || '',
      pIndex: paraIndexOf(sel.anchorNode),
    };
    ensureBar();
    barCount.textContent = '已选 ' + n + ' 字' + (n > MAX ? '（取前 ' + MAX + ' 字）' : '');
    showBar();
  }

  /* ---------- 卡片弹层 ---------- */
  var modal, modalImg;
  function ensureModal() {
    if (modal) return;
    var canSys = !!navigator.share;     // 支持 Web Share 才有系统分享面板（微信内置浏览器没有）
    modal = document.createElement('div');
    modal.className = 'share-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="sm-mask"></div>' +
      '<div class="sm-panel">' +
      '  <div class="sm-tip">' + (canSys ? '点「分享图片」直接转发，或长按图片保存' : '长按图片 · 保存或转发给好友') + '</div>' +
      '  <div class="sm-imgwrap"><img class="sm-img" alt="分享卡"></div>' +
      '  <div class="sm-acts">' +
      (canSys ? '    <button class="sm-sys sm-primary" type="button">分享图片</button>' : '') +
      '    <button class="sm-save' + (canSys ? '' : ' sm-primary') + '" type="button">保存图片</button>' +
      '    <button class="sm-copy" type="button">复制文字</button>' +
      '    <button class="sm-link" type="button">复制链接</button>' +
      '  </div>' +
      '  <button class="sm-close" type="button">关闭</button>' +
      '</div>';
    document.body.appendChild(modal);
    modalImg = $('.sm-img', modal);
    $('.sm-mask', modal).addEventListener('click', closeModal);
    $('.sm-close', modal).addEventListener('click', closeModal);
    $('.sm-save', modal).addEventListener('click', function () { saveImg(); });
    $('.sm-copy', modal).addEventListener('click', function () { copyText(lastText, this); });
    $('.sm-link', modal).addEventListener('click', function () { copyText(lastUrl, this); });
    var sys = $('.sm-sys', modal);
    if (sys) sys.addEventListener('click', sysShare);
  }
  function closeModal() { if (modal) modal.hidden = true; }

  async function openCard() {
    if (!picked) return;
    ensureModal();
    var text = picked.text.replace(/[ \t]+/g, ' ').trim();
    if (clen(text) > MAX) text = sliceByChars(text, MAX) + '…';
    // 出处：《书名》篇名（书名缺失则只用篇名）
    var src = (picked.book ? '《' + picked.book + '》' : '') + (picked.title || '');
    lastText = text + (src ? '\n——' + src : '');
    lastUrl = shareUrl(picked.id, picked.pIndex);
    modal.hidden = false;
    modalImg.removeAttribute('src');
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    var canvas = drawCard(text, src, lastUrl);
    modalImg.src = canvas.toDataURL('image/png');
    lastBlob = null;
    if (canvas.toBlob) canvas.toBlob(function (b) { lastBlob = b; }, 'image/png');
    hideBar();
  }

  /* ---------- 画「素简卡」：所选文字 + 出处（《书》篇）+ 裸二维码 ---------- */
  function drawCard(text, src, url) {
    var W = 1080, M = 96, TW = W - M * 2;
    var paper = '#f6f1e6', ink = '#322a1e', ink2 = '#6d5f49';
    var bodyFS = 41, LH = Math.round(bodyFS * 1.9), srcFS = 30, qrS = 168;
    var topPad = 96, srcGap = 50, qrGap = 56, botPad = 84;

    var probe = document.createElement('canvas').getContext('2d');
    probe.font = bodyFS + 'px ' + SERIF;
    var lines = layout(probe, text, TW, bodyFS);

    var bodyH = lines.length * LH;
    var sy = topPad + bodyH + srcGap + srcFS;        // 出处基线
    var qy = sy + qrGap;                              // 二维码顶
    var H = Math.round(qy + qrS + botPad);
    var DPR = Math.min(window.devicePixelRatio || 1, H > 4200 ? 1.5 : 2);

    var canvas = document.createElement('canvas');
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    var ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H);

    // 正文（左对齐，每段首行缩进二字）
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = bodyFS + 'px ' + SERIF;
    var y = topPad + bodyFS;
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i].t, M + (lines[i].indent ? bodyFS * 2 : 0), y);
      y += LH;
    }

    // 出处（右对齐落款）
    ctx.textAlign = 'right'; ctx.fillStyle = ink2; ctx.font = srcFS + 'px ' + SERIF;
    ctx.fillText(ellipsize(ctx, '——' + (src || '印光法师文钞'), TW), W - M, sy);

    // 二维码（居中，裸码，无文字）
    drawQR(ctx, url, (W - qrS) / 2, qy, qrS);
    return canvas;
  }

  // 把文本按宽度折行，保留段落（\n）、标记每段首行（缩进用）
  function layout(ctx, text, maxW, fs) {
    var out = [], paras = text.split('\n');
    for (var p = 0; p < paras.length; p++) {
      var s = paras[p].trim();
      if (!s) continue;
      var ln = '', first = true;
      for (var i = 0; i < s.length; i++) {
        var test = ln + s[i];
        var avail = maxW - (first ? fs * 2 : 0);
        if (ln && ctx.measureText(test).width > avail) {
          out.push({ t: ln, indent: first }); ln = s[i]; first = false;
        } else { ln = test; }
      }
      if (ln) out.push({ t: ln, indent: first });
    }
    return out;
  }

  // 二维码（本地 qrcode.js）
  function drawQR(ctx, text, x, y, size) {
    if (!window.qrcode) return;
    var qr = window.qrcode(0, 'M');
    qr.addData(text); qr.make();
    var n = qr.getModuleCount(), quiet = 4, cell = size / (n + quiet * 2);
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#1a1a1a';
    for (var r = 0; r < n; r++)
      for (var c = 0; c < n; c++)
        if (qr.isDark(r, c))
          ctx.fillRect(Math.round(x + (c + quiet) * cell), Math.round(y + (r + quiet) * cell),
            Math.ceil(cell), Math.ceil(cell));
  }

  function ellipsize(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }
  function sliceByChars(s, max) {
    var out = '', c = 0;
    for (var i = 0; i < s.length; i++) {
      out += s[i];
      if (!/\s/.test(s[i])) c++;
      if (c >= max) break;
    }
    return out;
  }

  /* ---------- 复制 / 保存 / 系统分享 ---------- */
  function copyText(text, btn) {
    var ok = function () { flash(btn, '已复制'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok, function () { execCopy(text, ok); });
    } else { execCopy(text, ok); }
  }
  function execCopy(text, ok) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch (e) {}
    try { document.execCommand('copy'); ok(); } catch (e) {}
    document.body.removeChild(ta);
  }
  function saveImg() {
    var url = modalImg && modalImg.src; if (!url) return;
    var a = document.createElement('a');
    a.href = url;
    a.download = '文钞·' + ((picked && picked.title) || '分享').replace(/[\\/:*?"<>|]/g, '') + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  async function sysShare() {
    try {
      var blob = lastBlob || dataURLtoBlob(modalImg && modalImg.src);
      if (blob && navigator.canShare) {
        var f = new File([blob], 'wenchao.png', { type: 'image/png' });
        if (navigator.canShare({ files: [f] })) {
          await navigator.share({ files: [f] });          // 直接把图片转发到已装社交软件
          return;
        }
      }
      await navigator.share({ text: lastText, url: lastUrl });   // 不支持图片则退化为文字+链接
    } catch (e) {}
  }
  function dataURLtoBlob(d) {
    if (!d || d.indexOf('data:') !== 0) return null;
    var parts = d.split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
    var bin = atob(parts[1]), n = bin.length, u8 = new Uint8Array(n);
    while (n--) u8[n] = bin.charCodeAt(n);
    return new Blob([u8], { type: mime });
  }
  function flash(btn, label) {
    if (!btn) return;
    var o = btn.textContent; btn.disabled = true; btn.textContent = label;
    setTimeout(function () { btn.textContent = o; btn.disabled = false; }, 1300);
  }

  /* ---------- 初始化 ---------- */
  document.addEventListener('selectionchange', onSelChange);
  window.addEventListener('hashchange', function () { hideBar(); closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); hideBar(); }
  });
})();
