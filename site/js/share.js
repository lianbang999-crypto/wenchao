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
  // CJK 避头尾：不可行首 / 不可行尾 字符
  var FORBID_START = '。，、；：！？）」』】》〕…·.,!?;:)]}％%”’';
  var FORBID_END = '（「『【《〔“‘([{';

  var picked = null;     // { text, id, title, pIndex }
  var lastUrl = '', lastText = '';

  function $(s, r) { return (r || document).querySelector(s); }
  function reader() { return document.getElementById('reader'); }
  function clen(s) { return s.replace(/\s/g, '').length; }   // 字数（忽略空白）

  function curId() {
    var m = location.pathname.match(/^\/a\/([\w-]+)\/?$/);
    if (m) return decodeURIComponent(m[1]);
    m = (location.hash || '').match(/^#\/a\/([\w-]+)/);
    return m ? m[1] : '';
  }
  function curTitle() {
    var h = $('.art-title');
    return h ? h.textContent.trim() : '印光法师文钞';
  }
  function shareUrl(id, p) {
    var base = CFG.shareBase || location.origin;
    base = base.replace(/[#?].*$/, '').replace(/\/+$/, '');
    return base + '/a/' + encodeURIComponent(id) + '/' + (p != null ? '?p=' + p : '');
  }
  // 选区起点所在段落是「原文」还是「白话」（白话为今译，分享时须注明，避免误作大师原话）
  function paraKindOf(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    var p = el && el.closest ? el.closest('p.p-orig, p.p-trans') : null;
    return p ? (p.classList.contains('p-trans') ? 'trans' : 'orig') : '';
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
    // 极简四键：划线 · 复制 · 朗读（从选中处读）· 法布施（分享结缘）
    bar.innerHTML =
      '<span class="sb-count" aria-live="polite"></span>' +
      '<button class="sb-btn sb-mark" type="button">' +
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="m14.3 5.7 4 4L9 19l-4.2.8L5.7 15.6z"/></svg>划线</button>' +
      '<button class="sb-btn sb-copy" type="button">' +
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>复制</span></button>' +
      '<button class="sb-btn sb-read" type="button">' +
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a4.5 4.5 0 0 1 0 7"/></svg>朗读</button>' +
      '<button class="sb-btn sb-make" type="button">' +
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.2 10.9 15.8 7.1M8.2 13.1l7.6 3.8"/></svg>法布施</button>' +
      '<span class="sb-sep" aria-hidden="true"></span>' +
      '<button class="sb-x" type="button" aria-label="取消">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>';
    document.body.appendChild(bar);
    barCount = $('.sb-count', bar);
    $('.sb-make', bar).addEventListener('click', openCard);
    // 划线：把选段存为高亮（app.js 提供）。传入选段时克隆的 Range，避免点按钮时活动选区已被收起
    $('.sb-mark', bar).addEventListener('click', function () {
      if (window.__wcHighlight && picked) window.__wcHighlight(picked.range);
      hideBar();
    });
    // 朗读：从选中处开始读（app.js 提供；起点/清选区/提示均复用其现成逻辑）
    $('.sb-read', bar).addEventListener('click', function () {
      if (window.__wcReadFrom && picked) window.__wcReadFrom(picked.range);
      hideBar();
    });
    // 复制：选段文字 + 出处落款（与法布施卡同口径），供摘抄笔记；轻反馈后自动收条
    $('.sb-copy', bar).addEventListener('click', function () {
      if (!picked) return;
      var text = picked.text.replace(/[ \t]+/g, ' ').trim();
      var src = srcOf(picked);
      copyText(text + (src ? '\n——' + src : ''), $('span', this));
      // 轻反馈显示完再收：清选区（防指针一动操作条又弹回）并收条
      setTimeout(function () {
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        hideBar();
      }, 1200);
    });
    $('.sb-x', bar).addEventListener('click', hideBar);
  }
  function showBar() {
    ensureBar();
    // 朗读条在场时上移堆叠其上，两条底部浮层不叠压
    var rb = document.querySelector('.read-bar');
    bar.style.marginBottom = (rb && !rb.hidden)
      ? (window.innerHeight - rb.getBoundingClientRect().top + 10) + 'px'
      : '';
    bar.hidden = false;
  }
  function hideBar() {
    if (bar) bar.hidden = true;
    lastSelKey = '';
  }

  /* ---------- 选区监听 ---------- */
  var timer, lastSelKey = '';
  function selectionKey(id, pIndex, text) {
    return [
      id,
      pIndex == null ? '' : pIndex,
      clen(text),
      text.replace(/\s+/g, ' ').slice(0, 80),
      text.replace(/\s+/g, ' ').slice(-40),
    ].join('|');
  }
  function scheduleSelectionEval(delay) {
    clearTimeout(timer);
    timer = setTimeout(evalSelection, delay || 220);
  }
  function onSelChange() { scheduleSelectionEval(220); }
  function evalSelection() {
    var id = curId();
    if (!id) { hideBar(); return; }   // 仅在阅读页
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideBar(); return; }
    var text = sel.toString();
    if (!text || !clen(text)) { hideBar(); return; }
    var body = $('.art-body', reader());
    if (!body || !body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) { hideBar(); return; }
    var n = clen(text);
    var pIndex = paraIndexOf(sel.anchorNode);
    var key = selectionKey(id, pIndex, text);
    if (key === lastSelKey && bar && !bar.hidden) return;
    lastSelKey = key;
    var meta = window.__wcShare || {};
    picked = {
      text: text, id: id,
      title: meta.title || curTitle(), book: meta.book || '',
      pIndex: pIndex, kind: paraKindOf(sel.anchorNode),
      range: sel.getRangeAt(0).cloneRange(),   // 供「划线」用：点按钮时活动选区可能已收起
    };
    ensureBar();
    barCount.textContent = n > MAX ? '仅取前 ' + MAX + ' 字分享' : '';   // 极简：平时不显字数，仅超限时轻提示
    showBar();
  }

  /* 安卓 APP（1.1.1 起）。WebView 里 <a download> 不触发下载、navigator.share 不存在、
     长按图片也没有 Chrome 那个「保存/分享」上下文菜单——三条路全断，
     故 APP 内的保存与分享都下沉到原生（见 NativeBridge 的 saveImage / shareImage）。 */
  function nativeShareOK() {
    try {
      var n = window.__wcNative;
      return !!(n && typeof n.shareImage === 'function' && window.__wcCall);
    } catch (e) { return false; }
  }

  /* ---------- 卡片弹层 ----------
     极简：一行提示 + 图 + 三键（保存图片·复制文字·复制链接）；关闭＝点蒙层或右上角 ✕。
     浏览器里不做「系统分享」键——微信内置浏览器不支持 navigator.share，
     支持处又与长按/保存重复；但 APP 里长按无效，故补一个「分享」键。 */
  var modal, modalImg;
  function ensureModal() {
    if (modal) return;
    var app = nativeShareOK();
    modal = document.createElement('div');
    modal.className = 'share-modal';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="sm-mask"></div>' +
      '<div class="sm-panel">' +
      '  <button class="sm-close" type="button" aria-label="关闭">' +
      '    <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>' +
      '  <div class="sm-tip">' + (app ? '可存入相册，或直接分享给好友' : '长按图片可直接转发') + '</div>' +
      '  <div class="sm-imgwrap"><img class="sm-img" alt="法布施卡"></div>' +
      '  <div class="sm-acts">' +
      (app ? '    <button class="sm-share sm-primary" type="button">分享</button>' +
             '    <button class="sm-save" type="button">保存图片</button>'
           : '    <button class="sm-save sm-primary" type="button">保存图片</button>') +
      '    <button class="sm-copy" type="button">复制文字</button>' +
      '    <button class="sm-link" type="button">复制链接</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);
    modalImg = $('.sm-img', modal);
    $('.sm-mask', modal).addEventListener('click', closeModal);
    $('.sm-close', modal).addEventListener('click', closeModal);
    $('.sm-save', modal).addEventListener('click', function () { saveImg(this); });
    var sh = $('.sm-share', modal);
    if (sh) sh.addEventListener('click', function () { shareImgNative(this); });
    $('.sm-copy', modal).addEventListener('click', function () { copyText(lastText, this); });
    $('.sm-link', modal).addEventListener('click', function () { copyText(lastUrl, this); });
  }
  function closeModal() { if (modal) modal.hidden = true; }

  // 出处落款：原文段只标《书名》篇名；白话段在书名后注明「白话文」（书名已含「白话」则不重复），
  // 避免今译被误作大师原话。复制与分享卡共用同一口径。
  function srcOf(p) {
    var book = p.book ? '《' + p.book + '》' : '';
    if (book && p.kind === 'trans' && !/白话/.test(p.book)) book += '白话文';
    var src = book + (book && p.title ? '·' : '') + (p.title || '');
    if (!book && p.kind === 'trans') src += '（白话）';
    return src;
  }

  async function openCard() {
    if (!picked) return;
    var text = picked.text.replace(/[ \t]+/g, ' ').trim();
    await showCard(text, srcOf(picked), shareUrl(picked.id, picked.pIndex), picked.title);
    hideBar();
  }

  /* 通用「制作分享卡」入口：选段分享与 AI 问答分享共用同一套绘制/二维码/系统分享。
   * text 支持多段（\n 分段，首行缩进）；src 为落款；url 进二维码；title 仅作保存文件名。 */
  async function showCard(text, src, url, title) {
    ensureModal();
    text = String(text || '').trim();
    if (clen(text) > MAX) text = sliceByChars(text, MAX) + '…';
    picked = picked || {};
    if (title) picked.title = title;
    lastText = text + (src ? '\n——' + src : '');
    lastUrl = url || (CFG.shareBase || location.origin);
    modal.hidden = false;
    modalImg.removeAttribute('src');
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    await ensureQR();
    var canvas = drawCard(text, src, lastUrl);
    modalImg.src = canvas.toDataURL('image/png');
  }

  /* AI 问答卡：问/答分区 + 顶部一行来源说明 + 二维码。与选段卡分开，避免把 AI 整理误作文钞原文。 */
  async function showAICard(question, answer, url) {
    ensureModal();
    question = String(question || '').trim();
    answer = String(answer || '').trim();
    if (clen(answer) > MAX) answer = sliceByChars(answer, MAX) + '…';
    picked = picked || {}; picked.title = '问文钞';
    lastText = '问：' + question + '\n\n' + answer;
    lastUrl = url || (CFG.shareBase || location.origin);
    modal.hidden = false;
    modalImg.removeAttribute('src');
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    await ensureQR();
    var canvas = drawAICard(question, answer, lastUrl);
    modalImg.src = canvas.toDataURL('image/png');
  }

  // 暴露给 app.js / ask.js：选段卡(card) 与 AI 问答卡(aiCard)
  window.WenchaoShare = { card: showCard, aiCard: showAICard };

  /* ---------- 画「法布施卡」：素纸细框 + 所选文字 + 出处落款 + 二维码 ----------
     极简三段式：正文（宽行距）· 落款行（右对齐出处）· 中缝短线下二维码。
     不加品牌抬头、不加印章，纯内容排版。 */
  function drawCard(text, src, url) {
    var W = 1080, M = 104, TW = W - M * 2, FI = 40;   // 宽 / 文字边距 / 界栏内框
    var paper = '#f6f1e6', ink = '#322a1e', ink2 = '#6d5f49', ink3 = '#a3937a',
        line = '#ddd2b8';
    var bodyFS = 41, LH = Math.round(bodyFS * 1.95), paraGap = Math.round(bodyFS * 0.7);
    var srcFS = 29, qrS = 156, topPad = 116, capFS = 25;

    var probe = document.createElement('canvas').getContext('2d');
    probe.font = bodyFS + 'px ' + SERIF;
    var lines = layout(probe, text, TW, bodyFS);
    var nGap = 0; for (var k = 0; k < lines.length; k++) if (lines[k].newPara) nGap++;

    var bodyH = lines.length * LH + nGap * paraGap;
    var srcBase = topPad + bodyH + 52 + srcFS;          // 落款基线
    var divY = srcBase + 52;                            // 中缝短线
    var qy = divY + 36;                                 // 二维码顶
    var capBase = qy + qrS + 30 + capFS;
    var H = Math.round(capBase + 66);
    var DPR = Math.min(window.devicePixelRatio || 1, H > 4200 ? 1.5 : 2);

    var canvas = document.createElement('canvas');
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    var ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H);
    // 极淡单线界栏（素简之质感，非装饰）
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.strokeRect(FI, FI, W - FI * 2, H - FI * 2);

    // 正文（左对齐，每段首行缩进二字，段间留白；折行已避头尾）
    ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.font = bodyFS + 'px ' + SERIF;
    var y = topPad + bodyFS;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].newPara) y += paraGap;
      ctx.fillText(lines[i].t, M + (lines[i].first ? bodyFS * 2 : 0), y);
      y += LH;
    }

    // 落款：右对齐一行出处
    ctx.textAlign = 'right'; ctx.fillStyle = ink2; ctx.font = srcFS + 'px ' + SERIF;
    ctx.fillText(ellipsize(ctx, '——' + (src || '印光法师文钞'), TW), W - M, srcBase);

    // 中缝短线 + 二维码（居中）+ 一行极简说明
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 44, divY); ctx.lineTo(W / 2 + 44, divY); ctx.stroke();
    drawQR(ctx, url, (W - qrS) / 2, qy, qrS);
    ctx.textAlign = 'center'; ctx.fillStyle = ink3; ctx.font = capFS + 'px ' + SERIF;
    ctx.fillText('扫码恭读原文', W / 2, capBase);
    return canvas;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // 问/答 方块标签（朱「问」墨「答」）
  function drawTag(ctx, ch, color, x, y, sz, fs) {
    roundRectPath(ctx, x, y, sz, sz, 9);
    ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = fs + 'px ' + SERIF;
    ctx.fillText(ch, x + sz / 2, y + sz / 2 + fs * 0.36);
  }

  // 解析回答为结构块：小标题(一、/##) · 序号(1.) · 要点(- ) · 段落，供分享卡分层排版
  function parseAnswerBlocks(answer) {
    var out = [], lines = String(answer || '').split('\n'), m;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln) continue;
      if ((m = ln.match(/^#{1,4}\s*(.+)$/)) ||
          (m = ln.match(/^((?:[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）)[^\n]{0,40})$/))) {
        out.push({ t: 'h', s: m[1] });
      } else if ((m = ln.match(/^(\d+)[.、)]\s*(.+)$/))) {
        out.push({ t: 'num', n: m[1], s: m[2] });
      } else if ((m = ln.match(/^[-*•●·]\s+(.+)$/))) {
        out.push({ t: 'li', s: m[1] });
      } else {
        out.push({ t: 'p', s: ln });
      }
    }
    return out;
  }

  /* 画「AI 问答卡」：顶部品牌 +「本文由 AI 基于《印光法师文钞》检索整理」一行；问/答分区，
   * 答案保留小标题/序号/要点的层次以便阅读；底部二维码「扫码进入「问文钞」」。 */
  function drawAICard(question, answer, url) {
    var W = 1080, M = 100, TW = W - M * 2, FI = 44;
    var paper = '#f6f1e6', ink = '#322a1e', ink2 = '#6d5f49', ink3 = '#a3937a', line = '#d9cdb2', cin = '#b03a26';
    var brandFS = 56, subFS = 27, bodyFS = 40, tagFS = 30, capFS = 28, qrS = 196;
    var qLH = Math.round(bodyFS * 1.55), aLH = Math.round(bodyFS * 1.85);
    var tagW = 48, tagGap = 22, colX = M + tagW + tagGap, colW = TW - (tagW + tagGap);
    var numIndent = Math.round(bodyFS * 1.7), liIndent = Math.round(bodyFS * 1.05);
    var hGap = Math.round(aLH * 0.45), bGap = Math.round(aLH * 0.12);

    var probe = document.createElement('canvas').getContext('2d');
    probe.font = bodyFS + 'px ' + SERIF;
    var qLines = layout(probe, question, colW, bodyFS);

    // 答区结构化预排版（求高）
    var blocks = parseAnswerBlocks(answer), items = [], aH = 0;
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b], gap = b === 0 ? 0 : (blk.t === 'h' ? hGap : bGap);
      var wide = blk.t === 'num' ? colW - numIndent : (blk.t === 'li' ? colW - liIndent : colW);
      probe.font = (blk.t === 'h' ? '500 ' : '') + bodyFS + 'px ' + SERIF;
      var it = { t: blk.t, n: blk.n, lines: layout(probe, blk.s, wide, bodyFS), gap: gap };
      aH += gap + it.lines.length * aLH;
      items.push(it);
    }

    var brandY = 96 + brandFS;
    var subY = brandY + 16 + subFS;
    var topDivY = subY + 34;
    var qBaseY = topDivY + 34 + bodyFS;
    var midDivY = qBaseY + (qLines.length - 1) * qLH + 34;
    var aTop = midDivY + 30;
    var aEndY = aTop + aH;
    var botDivY = aEndY + 34;
    var qrY = botDivY + 34;
    var capY = qrY + qrS + 34 + capFS;
    var H = Math.round(capY + 64);

    var DPR = Math.min(window.devicePixelRatio || 1, H > 4200 ? 1.5 : 2);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    var ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = line; ctx.lineWidth = 1.5;
    ctx.strokeRect(FI, FI, W - FI * 2, H - FI * 2);

    // 顶部：品牌 + 单行来源说明
    ctx.textAlign = 'center'; ctx.fillStyle = cin; ctx.font = '600 ' + brandFS + 'px ' + SERIF;
    ctx.fillText('问文钞', W / 2, brandY);
    ctx.fillStyle = ink3; ctx.font = subFS + 'px ' + SERIF;
    ctx.fillText('本文由 AI 基于《印光法师文钞》检索整理', W / 2, subY);
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 110, topDivY); ctx.lineTo(W / 2 + 110, topDivY); ctx.stroke();

    // 问区
    drawTag(ctx, '问', cin, M, qBaseY - bodyFS + 4, tagW, tagFS);
    ctx.textAlign = 'left'; ctx.fillStyle = ink; ctx.font = '500 ' + bodyFS + 'px ' + SERIF;
    for (var i = 0; i < qLines.length; i++) ctx.fillText(qLines[i].t, colX, qBaseY + i * qLH);

    // 中分隔
    ctx.strokeStyle = '#e6dcc5'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M, midDivY); ctx.lineTo(W - M, midDivY); ctx.stroke();

    // 答区：分层绘制（小标题加粗、序号悬挂缩进、要点缩进）
    drawTag(ctx, '答', ink2, M, aTop + 4, tagW, tagFS);
    ctx.textAlign = 'left';
    var y = aTop;
    for (var k = 0; k < items.length; k++) {
      var c = items[k]; y += c.gap;
      if (c.t === 'h') {
        ctx.fillStyle = ink; ctx.font = '500 ' + bodyFS + 'px ' + SERIF;
        for (var h = 0; h < c.lines.length; h++) { ctx.fillText(c.lines[h].t, colX, y + bodyFS); y += aLH; }
      } else if (c.t === 'num') {
        ctx.fillStyle = cin; ctx.font = '500 ' + bodyFS + 'px ' + SERIF;
        ctx.fillText(c.n + '.', colX, y + bodyFS);
        ctx.fillStyle = ink; ctx.font = bodyFS + 'px ' + SERIF;
        for (var u = 0; u < c.lines.length; u++) { ctx.fillText(c.lines[u].t, colX + numIndent, y + bodyFS); y += aLH; }
      } else if (c.t === 'li') {
        ctx.fillStyle = cin; ctx.font = bodyFS + 'px ' + SERIF;
        ctx.fillText('·', colX + 10, y + bodyFS);
        ctx.fillStyle = ink; ctx.font = bodyFS + 'px ' + SERIF;
        for (var v = 0; v < c.lines.length; v++) { ctx.fillText(c.lines[v].t, colX + liIndent, y + bodyFS); y += aLH; }
      } else {
        ctx.fillStyle = ink; ctx.font = bodyFS + 'px ' + SERIF;
        for (var w = 0; w < c.lines.length; w++) { ctx.fillText(c.lines[w].t, colX, y + bodyFS); y += aLH; }
      }
    }

    // 底分隔 + 二维码 + 说明
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 110, botDivY); ctx.lineTo(W / 2 + 110, botDivY); ctx.stroke();
    drawQR(ctx, url, (W - qrS) / 2, qrY, qrS);
    ctx.textAlign = 'center'; ctx.fillStyle = ink2; ctx.font = capFS + 'px ' + SERIF;
    ctx.fillText('扫码进入「问文钞」', W / 2, capY);
    return canvas;
  }

  // 折行：保留段落（\n）、首行缩进、避头尾（行首禁标点、行尾禁开括号）
  function layout(ctx, text, maxW, fs) {
    var out = [], paras = text.split('\n');
    for (var p = 0; p < paras.length; p++) {
      var s = paras[p].trim();
      if (!s) continue;
      var ln = '', lineNo = 0, np = out.length > 0;   // np：非首段，其首行加段距
      for (var i = 0; i < s.length; i++) {
        var ch = s[i];
        var avail = maxW - (lineNo === 0 ? fs * 2 : 0);
        if (ln && ctx.measureText(ln + ch).width > avail) {
          if (FORBID_START.indexOf(ch) >= 0) {
            ln += ch;                                  // 行首禁则：标点悬挂行尾
          } else {
            var last = ln.charAt(ln.length - 1);
            if (FORBID_END.indexOf(last) >= 0 && ln.length > 1) {
              out.push({ t: ln.slice(0, -1), first: lineNo === 0, newPara: lineNo === 0 && np });
              lineNo++; ln = last + ch;                // 行尾禁则：开括号挪到下一行
            } else {
              out.push({ t: ln, first: lineNo === 0, newPara: lineNo === 0 && np });
              lineNo++; ln = ch;
            }
          }
        } else {
          ln += ch;
        }
      }
      if (ln) out.push({ t: ln, first: lineNo === 0, newPara: lineNo === 0 && np });
    }
    return out;
  }

  // 二维码库(qrcode.js ~55KB)按需加载：绝大多数访问不生成分享卡，故首屏不再同步引入，
  // 首次做卡时才注入；失败也照常出卡（drawQR 有 !window.qrcode 兜底），仅少一枚二维码。
  var _qrLoad = null;
  function ensureQR() {
    if (window.qrcode) return Promise.resolve();
    if (_qrLoad) return _qrLoad;
    _qrLoad = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = '/js/qrcode.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { _qrLoad = null; resolve(); };
      document.head.appendChild(s);
    });
    return _qrLoad;
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
  function cardName() {
    return '法布施·' + ((picked && picked.title) || '文钞').replace(/[\\/:*?"<>|]/g, '');
  }
  function saveImg(btn) {
    var url = modalImg && modalImg.src; if (!url) return;
    // APP 内交给原生存相册：<a download> 在 WebView 里点了没反应
    if (nativeShareOK()) {
      if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
      window.__wcCall('saveImage', url, cardName()).then(function (r) {
        // 先把按钮文字复位再 flash——flash 记的是当下的文字，
        // 不复位它 1.3 秒后会把「保存中…」当成原文再写回去
        if (btn) { btn.disabled = false; btn.textContent = '保存图片'; }
        if (r && r.ok) flash(btn, '已存入相册');
        else say((r && r.error) || '保存失败');
      });
      return;
    }
    var a = document.createElement('a');
    a.href = url;
    a.download = cardName() + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  // APP 专用：交给系统分享面板（微信、QQ、相册……）
  function shareImgNative(btn) {
    var url = modalImg && modalImg.src; if (!url || !nativeShareOK()) return;
    if (btn) { btn.disabled = true; btn.textContent = '准备中…'; }
    window.__wcCall('shareImage', url, cardName()).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = '分享'; }
      if (!(r && r.ok)) say((r && r.error) || '分享失败');
    });
  }
  /* 出错时给用户一句话。不用 alert：WebView 没装 WebChromeClient 时它是不显示的，
     而这里的失败恰恰只在 APP 内发生——那正是最容易踩空的场合。优先借 app.js 的
     浮条，取不到再退回 alert（浏览器里一定有效）。 */
  function say(msg) {
    if (typeof window.__wcToast === 'function') { window.__wcToast(msg); return; }
    try { alert(msg); } catch (e) { }
  }
  function flash(btn, label) {
    if (!btn) return;
    var o = btn.textContent; btn.disabled = true; btn.textContent = label;
    setTimeout(function () { btn.textContent = o; btn.disabled = false; }, 1300);
  }

  /* ---------- 初始化 ---------- */
  window.__wcSelBarHide = hideBar;   // 供 app.js 在注释卡等弹层打开时收起选段条
  document.addEventListener('selectionchange', onSelChange);
  document.addEventListener('pointerup', function () { scheduleSelectionEval(90); });
  document.addEventListener('touchend', function () { scheduleSelectionEval(140); }, { passive: true });
  window.addEventListener('popstate', function () { hideBar(); closeModal(); });
  window.addEventListener('hashchange', function () { hideBar(); closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeModal(); hideBar(); }
  });
})();
