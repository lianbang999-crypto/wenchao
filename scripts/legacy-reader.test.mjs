import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../site/js/legacy.js', import.meta.url), 'utf8');
const books = JSON.parse(fs.readFileSync(new URL('../site/data/books.json', import.meta.url)));
const article = id => JSON.parse(fs.readFileSync(new URL('../site/data/articles/' + id + '.json', import.meta.url)));
const ids = books.flatMap(v => v.juans.flatMap(j => j.cats.flatMap(c => c.items.map(a => a.id))));

// Browser-shaped harness exercises only public UI events, XHR responses and saved data.
// Deliberately does not supply fetch, Promise or module helpers to the page.
function browser(initial = {}, options = {}) {
  const elements = {}, requests = [], timers = new Map(), storage = new Map(Object.entries(initial));
  let timerId = 0, hash = '', hashPending = false;
  const events = {}, docEvents = {};
  class Element {
    constructor(id, parent = null) { this.id = id; this.parentNode = parent; this.value = ''; this.children = []; this._html = ''; }
    set innerHTML(value) {
      const remove = el => { for (const child of el.children) { remove(child); delete elements[child.id]; } };
      remove(this); this.children = []; this._html = value;
      for (const match of value.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gi)) {
        const child = new Element(match[1], this);
        elements[child.id] = child; this.children.push(child);
      }
    }
    get innerHTML() { return this._html; }
    scrollIntoView() {}
  }
  for (const id of ['legacy-reader', 'legacy-home', 'legacy-storage-warning']) elements[id] = new Element(id);
  const document = {
    title: '', hidden: false,
    documentElement: { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 },
    body: { scrollTop: 0, scrollHeight: 5000 },
    getElementById(id) { return elements[id] || null; },
    addEventListener(name, fn) { docEvents[name] = fn; }
  };
  const window = {
    pageYOffset: 0, innerHeight: 800,
    scrollTo(x, y) { this.pageYOffset = y; },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { events[name] = fn; }
  };
  const location = {};
  Object.defineProperty(location, 'hash', {
    get() { return hash; },
    set(value) {
      if (hash !== value) {
        hash = value; hashPending = true;
        if (options.autoHashScroll) {
          window.pageYOffset = 0;
          if (window.onscroll) window.onscroll();
        }
      }
    }
  });
  class XHR {
    open(method, url) { this.url = url; }
    send() { requests.push(this); }
    abort() { this.aborted = true; } // Simulates a platform delivering a response despite cancellation.
    respond(data, status = 200) { this.responseText = JSON.stringify(data); this.status = status; this.readyState = 4; this.onreadystatechange(); }
  }
  const context = vm.createContext({ document, window, location, XMLHttpRequest: XHR,
    localStorage: { getItem(k) { return storage.get(k) ?? null; }, setItem(k, v) { storage.set(k, v); } } });
  vm.runInContext(source, context);
  requests[0].respond(books);
  function flushHash() { if (hashPending) { hashPending = false; window.onhashchange(); } }
  function clickData(scopeId, attribute, value) {
    const scope = elements[scopeId];
    assert.ok(scope.innerHTML.includes(`${attribute}="${value}"`), `Missing visible ${attribute}=${value}`);
    scope.onclick({ target: { getAttribute(key) { return key === attribute ? value : null; }, parentNode: elements['legacy-reader'] } });
    flushHash();
  }
  return {
    elements, requests, storage, window, document, location,
    clickData,
    deviceBack(hash) { location.hash = hash; flushHash(); },
    click(id) { assert.ok(elements[id]?.onclick, `Missing clickable ${id}`); elements[id].onclick(); flushHash(); },
    input(id, value) { elements[id].value = value; elements[id].oninput(); },
    select(id, value) { elements[id].value = value; elements[id].onchange(); },
    go(id, respond = true) {
      location.hash = '#article=' + id; flushHash();
      const request = requests[requests.length - 1];
      if (respond && request.url === '/data/articles/' + id + '.json' && request.readyState !== 4) request.respond(article(id));
      return request;
    },
    home() { this.click('legacy-home'); },
    read(key) { return JSON.parse(storage.get('wc.legacy.' + key) || 'null'); },
    flushTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    hide() { document.hidden = true; docEvents.visibilitychange(); },
    pagehide() { events.pagehide(); }
  };
}

test('every one of the 2565 corpus articles is reachable through bounded catalogue pages', () => {
  const b = browser(), reached = [];
  assert.equal(ids.length, 2565);
  assert.match(b.elements['legacy-results'].innerHTML, /共 2565 篇/);
  for (let page = 0; page < Math.ceil(ids.length / 60); page++) {
    if (page) b.select('legacy-page', String(page));
    const onPage = [...b.elements['legacy-results'].innerHTML.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]);
    assert.ok(onPage.length > 0 && onPage.length <= 60);
    reached.push(...onPage);
  }
  assert.deepEqual(reached, ids);
  b.clickData('legacy-results', 'data-id', ids.at(-1));
  assert.equal(b.location.hash, '#article=' + ids.at(-1));
  assert.equal(b.requests.at(-1).url, '/data/articles/' + ids.at(-1) + '.json');
});

test('filtering resets pagination and selecting a volume clears an earlier keyword', () => {
  const b = browser();
  b.select('legacy-page', '42');
  b.input('legacy-search', '一函遍复');
  assert.match(b.elements['legacy-results'].innerHTML, /data-id="jx-051"/);
  b.clickData('legacy-volumes', 'data-vol', books[1].id);
  assert.equal(b.elements['legacy-search'].value, '');
  const expected = books[1].juans.flatMap(j => j.cats.flatMap(c => c.items)).length;
  assert.ok(b.elements['legacy-results'].innerHTML.includes('共 ' + expected + ' 篇'));
});

test('an old XHR cannot overwrite a later article or the directory, and a click routes only once', () => {
  const b = browser();
  const requestA = b.go('jx-001', false), requestB = b.go('jx-002', false);
  requestB.respond(article('jx-002'));
  requestA.respond(article('jx-001'));
  assert.ok(b.elements['legacy-reader'].innerHTML.includes('<h1>' + article('jx-002').title + '</h1>'));
  assert.equal(b.read('last').id, 'jx-002');
  const requestC = b.go('jx-003', false);
  b.home(); requestC.respond(article('jx-003'));
  assert.ok(b.elements['legacy-results']);
  const before = b.requests.length;
  b.clickData('legacy-results', 'data-id', 'jx-004');
  assert.equal(b.requests.length, before + 1);
});

test('scroll saves the departing article and resumes it without corrupting the next article', () => {
  const b = browser();
  b.go('jx-001'); b.window.pageYOffset = 1234; b.window.onscroll();
  b.home(); b.flushTimers();
  assert.equal(b.read('position.jx-001').y, 1234);
  b.go('jx-002'); assert.equal(b.window.pageYOffset, 0);
  b.window.pageYOffset = 678; b.hide();
  assert.equal(b.read('position.jx-002').y, 678);
  b.home(); b.click('legacy-resume');
  assert.equal(b.location.hash, '#article=jx-002');
  assert.equal(b.window.pageYOffset, 678);
  b.go('jx-001'); assert.equal(b.window.pageYOffset, 1234);
  b.window.pageYOffset = 1400; b.pagehide(); assert.equal(b.read('position.jx-001').y, 1400);
});

test('white-text preference and size persist, with readable original fallback on articles lacking a translation', () => {
  const b = browser();
  b.go('jx-001'); b.window.pageYOffset = 1000;
  b.clickData('legacy-reader', 'data-mode', 'trans');
  assert.equal(b.read('mode'), 'trans');
  assert.ok(!b.elements['legacy-reader'].innerHTML.includes('class="legacy-original"'));
  assert.equal(b.window.pageYOffset, 1000);
  b.click('legacy-larger'); assert.equal(b.read('size'), 18);
  assert.match(b.elements['legacy-reader'].innerHTML, /font-size:18px/);
  b.home(); const req = b.go('jx-002', false);
  req.respond({ ...article('jx-002'), segments: [{ orig: ['无白话的原文仍然可读。'], trans: [], notes: [] }] });
  assert.match(b.elements['legacy-reader'].innerHTML, /本篇未附白话，显示原文/);
  assert.match(b.elements['legacy-reader'].innerHTML, /无白话的原文仍然可读/);
  assert.equal(b.read('mode'), 'trans');
  b.go('jx-003');
  assert.ok(b.elements['legacy-reader'].innerHTML.includes('data-mode="trans" class="active"'));
  const reopened = browser(Object.fromEntries(b.storage)); reopened.go('jx-001');
  assert.match(reopened.elements['legacy-reader'].innerHTML, /data-mode="trans" class="active"/);
  assert.match(reopened.elements['legacy-reader'].innerHTML, /font-size:18px/);
});

test('equal-length originals and translations alternate; unmatched blocks and repeated note numbers remain in source order', () => {
  const b = browser(), req = b.go('jx-001', false);
  req.respond({ ...article('jx-001'), segments: [
    { orig: ['原文甲', '原文乙'], trans: ['白话甲', '白话乙'], notes: [{ n: 1, term: '甲', text: '首则注释全文' }] },
    { orig: ['下一则原文甲', '下一则原文乙'], trans: ['下一则白话'], notes: [{ n: 1, term: '乙', text: '次则注释全文' }] }
  ] });
  const html = b.elements['legacy-reader'].innerHTML;
  const expected = ['原文甲', '白话甲', '原文乙', '白话乙', '首则注释全文', '下一则原文甲', '下一则原文乙', '下一则白话', '次则注释全文'];
  let previous = -1;
  for (const text of expected) { const index = html.indexOf(text, previous + 1); assert.ok(index > previous, text); previous = index; }
  const real = browser(); real.go('sbu-145');
  const htmlReal = real.elements['legacy-reader'].innerHTML;
  const notes = article('sbu-145').segments.flatMap(s => s.notes);
  assert.equal([...htmlReal.matchAll(/<li><b>注/g)].length, notes.length);
  assert.ok(htmlReal.includes('上堂法语第1则至第18则'));
});

test('the article cache evicts old entries and keeps only six recent articles', () => {
  const b = browser();
  for (let n = 1; n <= 7; n++) b.go('jx-' + String(n).padStart(3, '0'));
  const afterSeven = b.requests.length;
  b.go('jx-006'); assert.equal(b.requests.length, afterSeven, 'recent article should be reused');
  b.go('jx-001', false); assert.equal(b.requests.length, afterSeven + 1, 'evicted article must be loaded again');
});

test('malformed hashes and mismatched article responses show a safe recoverable error', () => {
  const b = browser();
  b.go('%E0%A4%A', false);
  assert.match(b.elements['legacy-reader'].innerHTML, /目录中没有找到/);
  b.click('legacy-error-back'); assert.ok(b.elements['legacy-results']);
  b.go('constructor', false);
  assert.match(b.elements['legacy-reader'].innerHTML, /目录中没有找到/);
  b.click('legacy-error-back');
  const req = b.go('jx-001', false); req.respond(article('jx-002'));
  assert.match(b.elements['legacy-reader'].innerHTML, /暂时无法打开/);
  assert.equal(b.read('last'), null);
});


test('article previous/next controls preserve the catalogue return and scrolling preferences', () => {
  const b = browser();
  b.select('legacy-page', '1');
  const firstId = [...b.elements['legacy-results'].innerHTML.matchAll(/data-id="([^"]+)"/g)][0][1];
  b.clickData('legacy-results', 'data-id', firstId);
  b.requests.at(-1).respond(article(firstId));
  const index = ids.indexOf(firstId);
  b.clickData('legacy-reader', 'data-id', ids[index + 1]);
  b.requests.at(-1).respond(article(ids[index + 1]));
  assert.equal(b.read('last').id, ids[index + 1]);
  b.clickData('legacy-reader', 'data-id', firstId);
  assert.equal(b.read('last').id, firstId);
  b.click('legacy-back');
  assert.match(b.elements['legacy-results'].innerHTML, /第 61—120 篇/);
});


test('navigating home saves before the WebView resets scrolling for an empty hash', () => {
  const b = browser({}, { autoHashScroll: true });
  b.go('jx-001');
  b.window.pageYOffset = 1200; // A click can occur before a pending scroll event.
  b.home(); b.flushTimers();
  assert.equal(b.read('position.jx-001').y, 1200);
  b.click('legacy-resume');
  assert.equal(b.window.pageYOffset, 1200);
});

test('device Back ignores hash navigation scrolling and saves the previous article snapshot', () => {
  const b = browser({}, { autoHashScroll: true });
  b.go('jx-001'); b.window.pageYOffset = 1200; b.window.onscroll();
  b.clickData('legacy-reader', 'data-id', 'jx-002');
  b.requests.at(-1).respond(article('jx-002'));
  b.window.pageYOffset = 760; b.window.onscroll();
  b.deviceBack('#article=jx-001'); b.flushTimers();
  assert.equal(b.read('position.jx-002').y, 760);
  assert.equal(b.read('position.jx-001').y, 1200);
  assert.equal(b.window.pageYOffset, 1200);
  b.window.pageYOffset = 1500; b.window.onscroll();
  b.deviceBack(''); b.flushTimers();
  assert.equal(b.read('position.jx-001').y, 1500);
  assert.ok(b.elements['legacy-results']);
});
