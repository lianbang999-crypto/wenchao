/* 安装到主屏（A2HS）引导。
   - Android / Chrome：捕获 beforeinstallprompt，点"安装"直接唤起系统安装。
   - iOS Safari：无该事件，给出"分享 → 添加到主屏幕"图文提示。
   - 已安装（standalone）或近期已关闭过则不显示。纯原生 DOM，配色取自 :root 主题变量。*/
(function () {
  'use strict';

  // 已经是独立窗口运行（装过了）就不打扰
  var standalone = window.matchMedia('(display-mode: standalone)').matches ||
                   window.navigator.standalone === true;
  if (standalone) return;

  var HIDE_KEY = 'pwa-a2hs-hide';
  var HIDE_DAYS = 14;
  try {
    var until = parseInt(localStorage.getItem(HIDE_KEY) || '0', 10);
    if (until && Date.now() < until) return;
  } catch (e) { /* localStorage 不可用则照常提示 */ }

  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
  var isSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  var deferredPrompt = null;

  function dismiss() {
    try { localStorage.setItem(HIDE_KEY, String(Date.now() + HIDE_DAYS * 864e5)); } catch (e) {}
    var el = document.getElementById('a2hs');
    if (el) el.remove();
  }

  function banner(inner) {
    if (document.getElementById('a2hs')) return null;
    var bar = document.createElement('div');
    bar.id = 'a2hs';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', '安装到主屏幕');
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:0', 'transform:translateX(-50%)',
      'z-index:2147483000', 'width:min(34rem,100%)', 'box-sizing:border-box',
      'display:flex', 'align-items:center', 'gap:.7rem',
      'padding:.7rem .85rem', 'padding-bottom:calc(.7rem + env(safe-area-inset-bottom,0))',
      'background:var(--paper,#f6f1e6)', 'color:var(--ink,#322a1e)',
      'border-top:1px solid var(--line,#d9cdb2)',
      'box-shadow:0 -6px 24px rgba(0,0,0,.12)',
      'font-family:var(--serif,serif)', 'font-size:14px', 'line-height:1.45',
      'animation:a2hs-up .28s ease both'
    ].join(';');
    bar.innerHTML =
      '<span aria-hidden="true" style="flex:0 0 auto;width:34px;height:34px;border-radius:8px;' +
      'background:var(--cinnabar,#b03a26);color:var(--paper,#f6f1e6);display:flex;' +
      'align-items:center;justify-content:center;font-weight:700;font-size:13px;letter-spacing:-1px">文钞</span>' +
      '<div style="flex:1 1 auto;min-width:0">' + inner + '</div>';

    var close = document.createElement('button');
    close.setAttribute('aria-label', '关闭');
    close.textContent = '✕';
    close.style.cssText = 'flex:0 0 auto;border:0;background:transparent;color:var(--ink,#322a1e);' +
      'opacity:.5;font-size:16px;line-height:1;padding:.3rem;cursor:pointer';
    close.onclick = dismiss;
    bar.appendChild(close);

    if (!document.getElementById('a2hs-style')) {
      var st = document.createElement('style');
      st.id = 'a2hs-style';
      st.textContent = '@keyframes a2hs-up{from{transform:translate(-50%,100%)}to{transform:translate(-50%,0)}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(bar);
    return bar;
  }

  // —— Android / Chrome：系统提供安装能力 ——
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    setTimeout(function () {
      var bar = banner('装到主屏，离线随时读，启动更快。');
      if (!bar) return;
      var btn = document.createElement('button');
      btn.textContent = '安装';
      btn.style.cssText = 'flex:0 0 auto;margin-left:.5rem;border:0;border-radius:8px;' +
        'background:var(--cinnabar,#b03a26);color:var(--paper,#f6f1e6);' +
        'font-family:inherit;font-size:14px;font-weight:600;padding:.42rem .9rem;cursor:pointer';
      btn.onclick = function () {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        deferredPrompt.userChoice.finally(function () { deferredPrompt = null; dismiss(); });
      };
      bar.insertBefore(btn, bar.lastChild); // 放在关闭按钮之前
    }, 2500);
  });

  // 装好后清理
  window.addEventListener('appinstalled', dismiss);

  // —— iOS Safari：只能引导手动添加 ——
  if (isSafari) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        banner('在 Safari 里点 <span aria-hidden="true">⎙</span> 分享 → “添加到主屏幕”，即可像 App 一样离线阅读。');
      }, 3000);
    });
  }
})();
