/* 印光法师文钞 · 独立问答页 /ask/
 * 复用共享内核 ai-core.js（与抽屉同一套排版/流式/出处/会话存储），
 * 打同一个 /api/ai；会话键 wc.aiSession 与抽屉互通（同设备）。 */
import { aiFormat, citationExcerpt, streamAsk, postFeedback, lstore, esc } from './ai-core.js';

const $ = (s) => document.querySelector(s);
const CFG = window.WENCHAO_CONFIG || {};
const SHARE_BASE = (CFG.shareBase || location.origin).replace(/\/$/, '');
const aiLog = $('#ai-log');
const aiText = $('#ai-text');
const shell = $('#ask-shell');
const aiForm = $('#ai-form');
const homeSlot = $('#ask-input-slot');
const aiDisc = document.querySelector('.ai-disclaimer');

const aiHistory = [];                          // 发给后端的上下文
let aiSession = lstore.get('aiSession', []);   // 与抽屉同键，天然互通
let aiAbort = null;

/* 单页双态：首页态把输入框移入首屏居中槽，对话态移回底部（同一节点，监听不丢） */
function setState(s) {
  shell.dataset.state = s;
  if (s === 'home') homeSlot.appendChild(aiForm);
  else shell.insertBefore(aiForm, aiDisc);     // 底部：对话区之后、免责声明之前
}

const FB_ICON = {
  up: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  speak: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4z"/><path d="M16 9a3.5 3.5 0 0 1 0 6M19 6.5a7 7 0 0 1 0 11"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
};

/* ---------- 渲染 ---------- */
function wireCites(div, passages) {
  div.querySelectorAll('.ai-cite').forEach((b) => {
    const p = passages && passages[+b.dataset.n - 1];
    b.onclick = () => showCitation(p);
    citeHover(b, p);
  });
}
function aiAppend(role, text, passages) {
  const div = document.createElement('div');
  div.className = 'ai-msg ' + (role === 'user' ? 'user' : 'bot');
  if (role === 'user') div.textContent = text;
  else { div.innerHTML = aiFormat(text, passages); wireCites(div, passages); }
  aiLog.appendChild(div);
  aiLog.scrollTop = aiLog.scrollHeight;
  return div;
}
/* ---------- 出处弹卡 ---------- */
function showCitation(p) {
  if (!p) return;
  const excerpt = citationExcerpt(p);
  const href = p.url ? SHARE_BASE + p.url : (p.aid ? SHARE_BASE + '/a/' + encodeURIComponent(p.aid) + '/' : '');
  $('#sheet-body').innerHTML =
    `<h4>《${esc(p.title || '')}》<span class="note-n">出处摘录</span></h4>` +
    `<p class="cite-text">${esc(excerpt)}</p>` +
    (href ? `<a class="sheet-goto" href="${esc(href)}">阅读原文 ›</a>` : '');
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; }

let aiTip;
const canHover = () => window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
function citeHover(btn, p) {
  if (!p || !canHover()) return;
  btn.addEventListener('mouseenter', () => {
    if (!aiTip) { aiTip = document.createElement('div'); aiTip.className = 'ai-tip'; document.body.appendChild(aiTip); }
    const orig = citationExcerpt(p);
    aiTip.innerHTML = `<b>《${esc(p.title || '')}》</b>${esc(orig.slice(0, 80))}${orig.length > 80 ? '…' : ''}`;
    aiTip.hidden = false;
    const r = btn.getBoundingClientRect();
    aiTip.style.left = Math.max(8, Math.min(r.left, innerWidth - aiTip.offsetWidth - 12)) + 'px';
    aiTip.style.top = (r.bottom + 6) + 'px';
  });
  btn.addEventListener('mouseleave', () => { if (aiTip) aiTip.hidden = true; });
}

/* ---------- 复制 / 朗读 ---------- */
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).catch(() => execCopy(t));
  else execCopy(t);
}
function execCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.top = '-1000px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}
const PRON = [['南无', '南摩'], ['南無', '南摩'], ['般若', '波惹'], ['伽蓝', '茄蓝'], ['阿弥陀', '婀弥陀'], ['比丘', '笔丘'], ['迦叶', '迦摄']];
function speakable(t) {
  t = t.replace(/\[\d{1,2}\]/g, '').replace(/\*\*/g, '')
    .replace(/^\s*\d+[.、)]\s*/gm, '').replace(/^\s*[-*•●]\s*/gm, '');
  PRON.forEach(([a, b]) => { t = t.split(a).join(b); });
  return t;
}
function aiSpeak(text, btn) {
  const synth = window.speechSynthesis;
  if (!synth) { btn.title = '此设备暂不支持朗读'; return; }
  if (btn.classList.contains('on')) { synth.cancel(); return; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(speakable(text));
  u.lang = 'zh-CN'; u.rate = 0.95;
  const v = (synth.getVoices() || []).find((x) => /zh|chinese|中文|普通话/i.test((x.lang || '') + (x.name || '')));
  if (v) u.voice = v;
  btn.classList.add('on'); btn.innerHTML = FB_ICON.stop; btn.title = '停止朗读';
  u.onend = u.onerror = () => { btn.classList.remove('on'); btn.innerHTML = FB_ICON.speak; btn.title = '朗读'; };
  synth.speak(u);
}

/* ---------- 分享：二维码直达本 /ask/ 页（带问题，扫码即重问） ---------- */
function aiShare(question, reply, passages) {
  if (!(window.WenchaoShare && window.WenchaoShare.aiCard)) { copyText(reply); return; }
  // 仅去引用角标与加粗符；保留小标题/序号/要点，供分享卡按结构排版
  const body = (reply || '')
    .replace(/\[\d{1,2}\]/g, '').replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
  window.WenchaoShare.aiCard(question, body, SHARE_BASE + '/ask/');
}

/* ---------- 反馈条 ---------- */
function aiFeedback(el, question, reply, passages) {
  const bar = document.createElement('div');
  bar.className = 'ai-fb';
  bar.innerHTML =
    '<button class="ai-fb-btn ai-speak" type="button" title="朗读" aria-label="朗读">' + FB_ICON.speak + '</button>' +
    '<button class="ai-fb-btn ai-copy" type="button" title="复制回答" aria-label="复制回答">' + FB_ICON.copy + '</button>' +
    '<button class="ai-fb-btn ai-share" type="button" title="分享问答" aria-label="分享问答">' + FB_ICON.share + '</button>' +
    '<span class="ai-fb-gap"></span>' +
    '<button class="ai-fb-btn" data-v="up" type="button" title="有帮助" aria-label="有帮助">' + FB_ICON.up + '</button>' +
    '<button class="ai-fb-btn" data-v="down" type="button" title="需更正" aria-label="需更正">' + FB_ICON.down + '</button>';
  el.appendChild(bar);
  bar.querySelector('.ai-speak').onclick = function () { aiSpeak(reply, this); };
  bar.querySelector('.ai-share').onclick = function () { aiShare(question, reply, passages); };
  const cp = bar.querySelector('.ai-copy');
  cp.onclick = () => {
    copyText(reply);
    cp.classList.add('ok'); cp.innerHTML = FB_ICON.check; cp.title = '已复制';
    setTimeout(() => { cp.classList.remove('ok'); cp.innerHTML = FB_ICON.copy; cp.title = '复制回答'; }, 1200);
  };
  bar.querySelectorAll('[data-v]').forEach((b) => {
    b.onclick = () => {
      postFeedback(CFG.aiEndpoint || '/api/ai', b.dataset.v, question, reply);
      bar.innerHTML = '<span class="ai-fb-thx">感谢您的反馈，南无阿弥陀佛。</span>';
    };
  });
}

/* ---------- 会话恢复 ---------- */
function saveSession() { try { lstore.set('aiSession', aiSession.slice(-30)); } catch {} }
function renderBot(rec) {
  const div = document.createElement('div');
  div.className = 'ai-msg bot';
  div.innerHTML = aiFormat(rec.c, rec.p);
  wireCites(div, rec.p);
  aiLog.appendChild(div);
  aiFeedback(div, rec.q, rec.c, rec.p);
  return div;
}
function aiInit() {
  if (aiSession.length) {
    setState('chat');
    aiHistory.length = 0;
    aiSession.forEach((rec) => {
      if (rec.r === 'u') { aiAppend('user', rec.c); aiHistory.push({ role: 'user', content: rec.c }); }
      else { renderBot(rec); aiHistory.push({ role: 'assistant', content: rec.c }); }
    });
    aiLog.scrollTop = aiLog.scrollHeight;
  } else {
    setState('home');
  }
}

/* ---------- 提问（流式） ---------- */
const aiSendBtn = () => $('.ai-send');
async function aiAsk(q) {
  if (shell.dataset.state !== 'chat') setState('chat');   // 首页态 → 对话态：首屏淡出、输入框移底
  aiAppend('user', q);
  aiHistory.push({ role: 'user', content: q });
  if (!CFG.aiEndpoint) {
    aiAppend('bot', 'AI 服务尚未接入（config.js 的 aiEndpoint 未配置）。');
    return;
  }
  const placeholder = document.createElement('div');
  placeholder.className = 'ai-msg bot ai-loading';
  placeholder.innerHTML = '<i>正在查阅文钞</i><span></span><span></span><span></span>';
  aiLog.appendChild(placeholder);
  aiLog.scrollTop = aiLog.scrollHeight;

  let passages = null, div = null, lastPaint = 0;
  const ensureDiv = () => {
    if (!div) {
      if (placeholder.parentNode) placeholder.remove();
      div = document.createElement('div'); div.className = 'ai-msg bot';
      aiLog.appendChild(div);
    }
    return div;
  };
  const paint = (full) => {
    const d = ensureDiv();
    d.innerHTML = aiFormat(full, passages);
    wireCites(d, passages);
    aiLog.scrollTop = aiLog.scrollHeight;
  };

  aiAbort = new AbortController();
  const sb = aiSendBtn(); if (sb) sb.textContent = '停止';
  let full = '', failed = false;
  try {
    const payload = { messages: aiHistory.slice(-8) };
    full = await streamAsk(CFG.aiEndpoint, payload, {
      onMeta: (ps) => { passages = ps; },
      onDelta: (f) => { const t = Date.now(); if (t - lastPaint > 120) { lastPaint = t; paint(f); } },
    }, aiAbort.signal);
  } catch (err) {
    if (!(err && err.name === 'AbortError')) {
      failed = true;
      if (placeholder.parentNode) placeholder.remove();
      aiAppend('bot', '请求失败，请稍后重试。');
    }
  } finally {
    aiAbort = null;
    const b = aiSendBtn(); if (b) b.textContent = '发送';
  }
  if (failed) return;
  if (placeholder.parentNode) placeholder.remove();
  if (!full) full = '（无回复）';
  paint(full);
  aiHistory.push({ role: 'assistant', content: full });
  if (full !== '（无回复）') {
    aiFeedback(ensureDiv(), q, full, passages);
    aiSession.push({ r: 'u', c: q });
    aiSession.push({ r: 'b', c: full, p: passages || [], q });
    saveSession();
  }
}

/* ---------- 接线 ---------- */
$('#ai-form').onsubmit = (e) => {
  e.preventDefault();
  if (aiAbort) { aiAbort.abort(); return; }
  const v = aiText.value.trim();
  if (!v) return;
  aiText.value = ''; aiText.style.height = 'auto';
  aiAsk(v);
};
aiText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    if (aiText.value.trim() && !aiAbort) $('#ai-form').dispatchEvent(new Event('submit', { cancelable: true }));
  }
});
aiText.addEventListener('input', () => {
  aiText.style.height = 'auto';
  aiText.style.height = Math.min(aiText.scrollHeight, 120) + 'px';
});
document.querySelectorAll('#ai-home [data-q]').forEach((b) => { b.onclick = () => aiAsk(b.dataset.q); });
const newBtn = $('#btn-ai-new');
if (newBtn) newBtn.onclick = () => {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  if (aiAbort) aiAbort.abort();
  aiHistory.length = 0; aiSession.length = 0; saveSession();
  aiLog.innerHTML = '';
  aiText.value = ''; aiText.style.height = 'auto';
  setState('home');
};
$('#sheet-backdrop').onclick = closeSheet;
const sheetClose = $('#sheet-close'); if (sheetClose) sheetClose.onclick = closeSheet;

/* 启动：恢复本地会话（与抽屉互通），不做自动提问——扫码/分享进来只打开页面 */
aiInit();
