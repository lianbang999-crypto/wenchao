import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const pwa = readFileSync(new URL('../site/js/pwa.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../site/js/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function installSectionHtml()');
const end = app.indexOf('\nfunction wireInstall(', start);
const installSection = app.slice(start, end);

function render({ ua, touch = 0, coarse = false, width = 1280, uaDataMobile = false }) {
  const listeners = {};
  const window = {
    screen: { width }, innerWidth: width, MSStream: false,
    matchMedia: query => ({ matches: query === '(pointer: coarse)' ? coarse : false }),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    navigator: { standalone: false },
  };
  const navigator = {
    userAgent: ua, maxTouchPoints: touch,
    userAgentData: { mobile: uaDataMobile }, standalone: false,
  };
  window.navigator = navigator;
  const context = vm.createContext({ window, navigator, CFG: { apkUrl: '/app/wenchao.apk' },
    esc: value => String(value), document: {}, localStorage: {}, setTimeout() {} });
  vm.runInContext(pwa, context);
  vm.runInContext(installSection + '\nvar renderedInstallSection = installSectionHtml();', context);
  return { html: context.renderedInstallSection, device: window.__wcInstall };
}

test('Baidu phone with hidden OS receives phone instructions rather than computer instructions', () => {
  const { html, device } = render({ ua: 'Baiduboxapp/14.0 Mobile', touch: 5, coarse: true, width: 412 });
  assert.equal(device.isAndroid, false);
  assert.equal(device.isMobile, true);
  assert.match(html, /手机 · 安装应用/);
  assert.match(html, /复制网址/);
  assert.doesNotMatch(html, /电脑|下载安卓应用/);
});

test('unknown narrow touch phone offers generic install and clearly labels Android APK', () => {
  const { html } = render({ ua: 'CustomBrowser', touch: 5, coarse: true, width: 390 });
  assert.match(html, /手机 · 安装应用/);
  assert.match(html, /仅限安卓/);
  assert.doesNotMatch(html, /电脑/);
});

test('ordinary Android, iPhone and desktop keep platform-specific guidance', () => {
  const android = render({ ua: 'Mozilla/5.0 (Linux; Android 15) Chrome', touch: 5, coarse: true, width: 412 }).html;
  const iphone = render({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18) AppleWebKit Safari', touch: 5, coarse: true, width: 390 }).html;
  const desktop = render({ ua: 'Mozilla/5.0 (Macintosh) Chrome', width: 1440 }).html;
  assert.match(android, /安卓 · 下载应用|下载安装/);
  assert.match(iphone, /iPhone · 添加到主屏/);
  assert.doesNotMatch(iphone, /安卓应用/);
  assert.match(desktop, /电脑 · 安装应用/);
});
