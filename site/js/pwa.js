/* 安装到主屏（A2HS）：底部横幅引导 + 对外安装 API。
   - beforeinstallprompt 全局只触发一次：无论是否显示横幅都必须无条件捕获，
     否则 standalone / 静默期早退会让「我的」页的安装按钮永久拿不到安装能力。
   - 横幅仍守旧规矩：已安装或近 14 天关过就不打扰；「我的」页按钮不受静默期约束
     （用户主动进设置找安装，理应总能装）。
   - window.__wcInstall 供 app.js 渲染「我的」页安装区。 */
(function () {
  'use strict';

  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) && !window.MSStream;
  var isSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  var isAndroid = /android/i.test(ua);
  // 微信/QQ/微博/UC 等内置 WebView：无 A2HS 能力，只能引导到系统浏览器打开
  var inAppBrowser = /micromessenger|qq\/|qqbrowser|weibo|baiduboxapp|ucbrowser|quark/i.test(ua);
  /* 离线 APP 的 WebView 不是从 manifest 启动的 PWA，display-mode 那两个判据都不成立，
     可它显然已经是「装好的应用」了。漏掉这一条，「我的」页会对着已装用户继续劝装。
     __wcNative 由原生在载入页面前注入，此处必定已可见。 */
  var inNativeApp = typeof window.__wcNative === 'object' && window.__wcNative !== null;
  var standalone = inNativeApp ||
                   window.matchMedia('(display-mode: standalone)').matches ||
                   window.navigator.standalone === true;

  var HIDE_KEY = 'pwa-a2hs-hide';
  var HIDE_DAYS = 14;
  var deferredPrompt = null;

  /* ---- 对外 API（app.js 用）---- */
  window.__wcInstall = {
    standalone: standalone,
    isIOS: isIOS,
    isSafari: isSafari,
    isAndroid: isAndroid,
    inAppBrowser: inAppBrowser,
    canPrompt: function () { return !!deferredPrompt; },
    // 唤起系统安装弹窗；返回 Promise<'accepted'|'dismissed'|'unavailable'>
    prompt: function () {
      if (!deferredPrompt) return Promise.resolve('unavailable');
      var dp = deferredPrompt;
      dp.prompt();
      return dp.userChoice.then(function (r) {
        deferredPrompt = null;                 // prompt() 只能用一次
        notify();
        return (r && r.outcome) || 'dismissed';
      }).catch(function () { return 'dismissed'; });
    },
  };
  // 状态变了通知「我的」页重绘（事件可能晚于页面渲染到达）
  function notify() {
    try { window.dispatchEvent(new CustomEvent('wc-install-change')); } catch (e) {}
  }

  /* ---- 无条件捕获：早退会让事件永久丢失 ---- */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    notify();
    // 安卓有正式安装包，且它是离线的、比 PWA 强得多；再弹一条 PWA 横幅只会
    // 让人分不清装哪个。故安卓这边由下面的 showApkBanner 统一引导，
    // PWA 安装能力仍留着，供浏览器菜单与桌面端使用。
    if (isAndroid) return;
    if (!bannerAllowed()) return;              // 不显示横幅，但安装能力已存下
    setTimeout(showInstallBanner, 2500);
  });
  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    window.__wcInstall.standalone = true;      // 「我的」页据此切到「已安装」
    notify();
    dismiss();
  });

  /* ---- 底部横幅（原有引导，规则不变）---- */
  function bannerAllowed() {
    if (standalone) return false;
    try {
      var until = parseInt(localStorage.getItem(HIDE_KEY) || '0', 10);
      if (until && Date.now() < until) return false;
    } catch (e) { /* localStorage 不可用则照常提示 */ }
    return true;
  }

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

  function showInstallBanner() {
    var bar = banner('装到主屏，离线随时读，启动更快。');
    if (!bar) return;
    var btn = document.createElement('button');
    btn.textContent = '安装';
    btn.style.cssText = 'flex:0 0 auto;margin-left:.5rem;border:0;border-radius:8px;' +
      'background:var(--cinnabar,#b03a26);color:var(--paper,#f6f1e6);' +
      'font-family:inherit;font-size:14px;font-weight:600;padding:.42rem .9rem;cursor:pointer';
    btn.onclick = function () {
      // 不用 .finally()：它要 Chrome 63+，比本站的兼容下限还高一档。
      // 两个回调都收口到 dismiss，等价于 finally。
      var done = function () { dismiss(); };
      window.__wcInstall.prompt().then(done, done);
    };
    bar.insertBefore(btn, bar.lastChild); // 放在关闭按钮之前
  }

  /* —— 安卓：引导下载离线应用 ——
     网页版每翻一篇都要联网，而应用装完即可离线读全部 2565 篇。这个差别对
     网络不稳的用户是决定性的（此前「打不开」的投诉多半就出在这儿），
     值得主动说一句，而不是藏在「我的」页里等人自己找。
     节流沿用同一套：关掉之后 14 天不再打扰；已装的（standalone）根本不显示。 */
  function apkHref() {
    try {
      var c = window.WENCHAO_CONFIG || {};
      return c.apkUrl || '';
    } catch (e) { return ''; }
  }

  function showApkBanner() {
    var url = apkHref();
    if (!url) return;                       // 没配安装包地址就别提，免得给个死链
    var bar;
    if (inAppBrowser) {
      // 微信/QQ 等内置浏览器会拦下 apk 下载，直接给按钮只会让人点了没反应，
      // 故这里只讲怎么绕出去，不放下载键。
      bar = banner('<b>装上离线版，断网也能读</b><br>' +
        '<span style="opacity:.75">请点右上角「⋯」→ 在浏览器中打开，再下载</span>');
      return;
    }
    bar = banner('<b>装上离线版，断网也能读</b><br>' +
      '<span style="opacity:.75">全部 2565 篇随包带走，约 20MB</span>');
    if (!bar) return;
    var a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', '');
    a.textContent = '下载';
    a.style.cssText = 'flex:0 0 auto;margin-left:.5rem;border:0;border-radius:8px;' +
      'background:var(--cinnabar,#b03a26);color:var(--paper,#f6f1e6);text-decoration:none;' +
      'font-family:inherit;font-size:14px;font-weight:600;padding:.42rem .9rem;cursor:pointer';
    a.onclick = function () { setTimeout(dismiss, 400); };   // 点了就别再纠缠
    bar.insertBefore(a, bar.lastChild);     // 放在关闭按钮之前
  }

  if (isAndroid && bannerAllowed()) {
    window.addEventListener('load', function () {
      // 比 PWA 那条晚一点：让人先看到正文，别一进门就被弹窗迎面挡住
      setTimeout(showApkBanner, 4000);
    });
  }

  // —— iOS Safari：无 beforeinstallprompt，只能引导手动添加 ——
  if (isSafari && bannerAllowed()) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        banner('在 Safari 里点 <span aria-hidden="true">⎙</span> 分享 →「添加到主屏幕」，即可像 App 一样离线阅读。');
      }, 3000);
    });
  }
})();
