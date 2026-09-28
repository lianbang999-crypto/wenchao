/* 印光法师文钞 · AI 助读「共享内核」
 * 抽屉(app.js)与独立页(ask.js)共用的纯逻辑，避免两处重复维护。
 * 只含与具体页面 DOM 无关的部分：HTML 转义、回答排版(轻量 Markdown + 角标)、
 * 出处摘录、流式问答、反馈上报、本地会话存储(与抽屉同源同键，故同设备会话天然互通)。 */

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* 本地存储：与 app.js 的 store 同前缀(wc.)、同键(aiSession)，
 * 因而同一设备同一浏览器下，抽屉与独立页的会话历史天然互通。 */
export const lstore = {
  // 不用 ??：它要 Chrome 80+ 才认，旧安卓的系统 WebView 会整份解析失败、阅读器全哑。
  // 判 null/undefined 而非 falsy，是为了让存下的 false / 0 不被默认值顶掉。
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('wc.' + k)); return v === null || v === undefined ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('wc.' + k, JSON.stringify(v)); } catch (e) {} },
};

/* 轻量 Markdown（小标题 / 粗体 / 有序·无序列表 / 一级子项 / 段落）+ 行内角标 [n]。
 * 仿 NotebookLM：多层次回答用「一、」小标题分节、子项缩进，便于扫读。 */
export function aiFormat(text, passages) {
  const t = esc(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  let html = '', list = '', sub = false, liOpen = false;
  const closeSub = () => { if (sub) { html += '</ul>'; sub = false; } };
  const closeLi = () => { if (liOpen) { closeSub(); html += '</li>'; liOpen = false; } };
  const closeList = () => { closeLi(); if (list) { html += '</' + list + '>'; list = ''; } };
  for (const raw of t.split('\n')) {
    const indented = /^\s{2,}/.test(raw);
    const ln = raw.trim();
    if (!ln) continue;   // 空行跳过即可，勿关闭列表（否则每项各成一个 ol、序号都回到1）
    let m;
    // 小标题：markdown # / 「一、…」/「（一）…」（独占一行、较短）
    if ((m = ln.match(/^#{1,4}\s*(.+)$/)) ||
        (m = ln.match(/^(?:<strong>)?\s*((?:[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）)[^<\n]{0,40})(?:<\/strong>)?$/))) {
      closeList(); html += '<h4 class="ai-h">' + m[1] + '</h4>';
    // 子项：「○ ◦」标记，或缩进的 - * • —— 挂到当前条目下成一级子列表
    } else if (liOpen && ((m = ln.match(/^[○◦]\s+(.+)$/)) || (indented && (m = ln.match(/^[-*•·]\s+(.+)$/))))) {
      if (!sub) { html += '<ul class="ai-sub">'; sub = true; }
      html += '<li>' + m[1] + '</li>';
    } else if ((m = ln.match(/^(\d+)[.、)]\s*(.+)$/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } else closeLi();
      html += '<li>' + m[2]; liOpen = true;
    } else if ((m = ln.match(/^[-*●·•]\s+(.+)$/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } else closeLi();
      html += '<li>' + m[1]; liOpen = true;
    } else {
      closeList(); html += '<p>' + ln + '</p>';
    }
  }
  closeList();
  if (passages && passages.length) {
    html = html.replace(/\[(\d{1,2})\]/g, (mm, n) =>
      passages[+n - 1] ? '<button class="ai-cite" data-n="' + n + '">' + n + '</button>' : mm);
  }
  return html;
}

/* 出处摘录：统一只显原文（白话在「阅读原文」里看），用于角标弹卡 / 悬停预览。 */
export function citationExcerpt(p) {
  const t = (p && p.text) || '';
  const orig = (t.split('\n（白话）')[0] || '').trim();
  return (orig && !orig.startsWith('（白话）')) ? orig : t.trim();
}

/* 流式问答：POST 后端(ndjson 逐行 meta/delta/done)，逐行回调。返回完整回答文本。
 * handlers: { onMeta(passages, sources, cite), onDelta(fullText, deltaText) }
 * 兼容非流式与错误体 {reply:'…'}（无 type）：照样并入文本，不吞成"无回复"。 */
export async function streamAsk(endpoint, payload, handlers, signal) {
  const { onMeta, onDelta, onDone } = handlers || {};
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal,
  });
  let full = '';
  const onMsg = (m) => {
    if (!m) return;
    if (m.type === 'meta') { if (onMeta) onMeta(m.passages || [], m.sources || [], m.cite || ''); }
    else if (m.type === 'delta') { full += m.text || ''; if (onDelta) onDelta(full, m.text || ''); }
    else if (m.type === 'done') { if (onDone) onDone(m.verify || null); }   // 引用逐字自检信号，供前端渲染核验徽标
    else if (typeof m.reply === 'string' && m.reply) { full += m.reply; if (onDelta) onDelta(full, m.reply); }
  };
  if (res.body && res.body.getReader) {                 // 流式（打字机）
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (line) try { onMsg(JSON.parse(line)); } catch (e) { /* 半行 */ }
      }
    }
    if (buf.trim()) try { onMsg(JSON.parse(buf.trim())); } catch (e) { /* 末行无换行的 {reply} 错误体 */ }
  } else {                                              // 不支持流式：整体读取
    (await res.text()).split('\n').forEach((l) => { if (l.trim()) try { onMsg(JSON.parse(l)); } catch (e) {} });
  }
  return full;
}

/* 反馈上报：有帮助 / 需更正 → 后端 /feedback（供日后人工审核沉淀）。best-effort。 */
export function postFeedback(endpoint, vote, question, reply) {
  return fetch(endpoint.replace(/\/$/, '') + '/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote, question, reply }),
  }).catch(() => {});
}

/* ---------- AI 回答朗读：高清(服务端 CosyVoice2) 优先，失败降级本机 speechSynthesis ----------
 * AI 回答通常 ≤500 字（在 /tts 单次上限内），一次合成即可，无需阅读器那套逐句队列/预取。
 * 与阅读器共用同一 /tts 端点与音色；高清引擎由服务端 READ_DICT 归一读音，故高清路径不再本地替换。 */

// 佛门高频词读音（仅本机降级引擎用；高清由服务端 READ_DICT 处理，勿重复替换）
const SPEAK_PRON = [['南无', '南摩'], ['南無', '南摩'], ['般若', '波惹'], ['伽蓝', '茄蓝'], ['阿弥陀', '婀弥陀'], ['比丘', '笔丘'], ['迦叶', '迦摄']];
// 去掉角标 [n] / 加粗符 / 列表序号，得到适合朗读的纯文本
export function speakableText(t) {
  return String(t || '')
    .replace(/\[\d{1,2}\]/g, '').replace(/\*\*/g, '')
    .replace(/^\s*\d+[.、)]\s*/gm, '').replace(/^\s*[-*•●·]\s*/gm, '');
}
// 朗读用纯文本 + 佛门读音替换（阅读器本机朗读 playLocal 与 AI 本机降级共用同一张表）
export function localPron(t) { let s = speakableText(t); SPEAK_PRON.forEach(([a, b]) => { s = s.split(a).join(b); }); return s; }

// 单例状态：同一时刻只读一条回答；token 作废进行中的异步回调，避免切走后误播/误改按钮
let _aiAudio = null, _aiToken = 0;
function aiAudioEl() { if (!_aiAudio) { _aiAudio = new Audio(); _aiAudio.preload = 'auto'; } return _aiAudio; }

/* 安卓 APP 的系统朗读。Android WebView 不实现 Web Speech API 的合成部分——
   'speechSynthesis' 在也白在：getVoices() 空、speak() 无声、onend 不回调。
   故 APP 内改走原生（NativeBridge.ttsSpeak），由 app.js 挂在 window.__wcCall 上。 */
function nativeTtsOK() {
  try {
    const n = window.__wcNative;
    return !!(n && typeof n.ttsAvailable === 'function' && n.ttsAvailable());
  } catch (e) { return false; }
}

/* 立即停止任何 AI 朗读（高清音频 + 本机合成）。新对话/关面板/再点按钮时调用。 */
export function aiSpeakStop() {
  _aiToken++;
  if (_aiAudio) { try { _aiAudio.pause(); } catch (e) {} _aiAudio.onended = _aiAudio.onerror = null; }
  if (nativeTtsOK()) { try { window.__wcNative.ttsStop(); } catch (e) {} }
  if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.cancel(); } catch (e) {} }
}

// 本机降级：APP 走系统 TTS，浏览器走 speechSynthesis（都免费·离线可用）
function speakLocal(reply, token, onIdle) {
  if (nativeTtsOK()) {
    const call = window.__wcCall;
    if (!call) { onIdle(); return false; }
    call('ttsSpeak', localPron(reply), 0.95)
      .then(() => { if (token === _aiToken) onIdle(); });
    return true;
  }
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  if (!synth) { onIdle(); return false; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(localPron(reply));
  u.lang = 'zh-CN'; u.rate = 0.95;
  const v = (synth.getVoices() || []).find((x) => /zh|chinese|中文|普通话|han/i.test((x.lang || '') + (x.name || '')));
  if (v) u.voice = v;
  u.onend = u.onerror = () => { if (token === _aiToken) onIdle(); };
  try { synth.speak(u); } catch (e) { onIdle(); return false; }
  return true;
}

/* 朗读一条 AI 回答。回调 { onPlaying(), onIdle() } 驱动按钮 UI（播放中/闲置）。
 * 流程：/tts 取高清音频 → <audio> 播放；任何失败（网络/上游/额度/不支持音频）自动降级本机。 */
export async function aiSpeakReply(endpoint, reply, cbs, voice) {
  const onPlaying = (cbs && cbs.onPlaying) || (() => {});
  const onIdle = (cbs && cbs.onIdle) || (() => {});
  const token = ++_aiToken;
  const isCur = () => token === _aiToken;
  const text = speakableText(reply).slice(0, 2000);
  let blobUrl = null;
  try {
    const res = await fetch(endpoint.replace(/\/$/, '') + '/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, layer: 't', voice: voice || 'charles' }),
    });
    if (!res.ok) throw new Error('tts ' + res.status);
    const blob = await res.blob();
    if (!isCur()) return;                       // 期间被停止/切走：丢弃
    blobUrl = URL.createObjectURL(blob);
    const a = aiAudioEl();
    a.src = blobUrl; a.playbackRate = 1;
    a.onended = () => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} if (isCur()) onIdle(); };
    a.onerror = () => { try { URL.revokeObjectURL(blobUrl); } catch (e) {} if (isCur() && !speakLocal(reply, token, onIdle)) onIdle(); };
    onPlaying();
    await a.play().catch(() => {});
  } catch (e) {
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }
    if (!isCur()) return;
    onPlaying();                                // 高清失败 → 本机续读（本机 onend 会复位为 idle）
    if (!speakLocal(reply, token, onIdle)) onIdle();
  }
}

/* 反馈条「朗读」按钮的点按开关：闲置→开始（先 loading 再 playing），播放中/加载中→停止。
 * icons = { speak, stop }；由调用方传入本页的 SVG，保持外观一致。 */
export function aiSpeakToggle(endpoint, reply, btn, icons, voice) {
  const toIdle = () => { btn.classList.remove('on', 'loading'); btn.innerHTML = icons.speak; btn.title = '朗读'; };
  if (btn.classList.contains('on') || btn.classList.contains('loading')) { aiSpeakStop(); toIdle(); return; }
  btn.classList.add('loading'); btn.title = '正在合成…';
  aiSpeakReply(endpoint, reply, {
    onPlaying() { btn.classList.remove('loading'); btn.classList.add('on'); btn.innerHTML = icons.stop; btn.title = '停止朗读'; },
    onIdle: toIdle,
  }, voice);
}

/* 引用核验徽标：把后端 done.verify（引用逐字自检结果）翻成一句可信度提示。
 * 贴「不妄语·可核验优先」——据实标注，不夸大：
 *   · 有直引且逐字对上 → 绿「引文已核验」
 *   · 仅有出处编号(无直引) → 中性「已附 N 处出处」
 *   · 有越界编号或直引对不上 → 琥珀「部分引用请核对」
 * 无任何引用则不显示（避免噪声，页底免责声明已兜底）。返回 HTML 字符串或 ''。 */
export function verifyBadgeHTML(verify) {
  if (!verify || !verify.cited) return '';
  const ICON_OK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  if (!verify.faithful) {
    return `<div class="ai-verify warn" title="回答中的方括号引用存在越界编号，或直引原文未能与所标出处逐字对上，请点开出处核对">${ICON_WARN}部分引用请核对原文</div>`;
  }
  if (verify.quoteChecked > 0) {
    return `<div class="ai-verify ok" title="回答中 ${verify.quoteChecked} 处直引已与所标出处逐字比对一致">${ICON_OK}引文已核验 · 与出处逐字一致</div>`;
  }
  return `<div class="ai-verify ok" title="回答已标注 ${verify.cited} 处出处编号，均在检索资料范围内，可点开逐条核对">${ICON_OK}已附 ${verify.cited} 处出处 · 可点开核对</div>`;
}

/* ---------- 出处角标 / 反馈条 公用件（抽屉 app.js 与独立页 ask.js 逐字相同，故集中于此） ---------- */

// 反馈条按钮图标集
export const FB_ICON = {
  up: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  speak: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4z"/><path d="M16 9a3.5 3.5 0 0 1 0 6M19 6.5a7 7 0 0 1 0 11"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
};

// 角标 hover 预览（仅"有真鼠标"的桌面启用；手机/触屏一律走点按弹卡）
let _aiTip;
const canHover = () => window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
export function citeHover(btn, p) {
  if (!p || !canHover()) return;
  btn.addEventListener('mouseenter', () => {
    if (!_aiTip) { _aiTip = document.createElement('div'); _aiTip.className = 'ai-tip'; document.body.appendChild(_aiTip); }
    const orig = citationExcerpt(p);
    _aiTip.innerHTML = `<b>《${esc(p.title || '')}》</b>${esc(orig.slice(0, 80))}${orig.length > 80 ? '…' : ''}`;
    _aiTip.hidden = false;
    const r = btn.getBoundingClientRect();
    _aiTip.style.left = Math.max(8, Math.min(r.left, innerWidth - _aiTip.offsetWidth - 12)) + 'px';
    _aiTip.style.top = (r.bottom + 6) + 'px';
  });
  btn.addEventListener('mouseleave', () => { if (_aiTip) _aiTip.hidden = true; });
}

// 复制：优先 navigator.clipboard（安全上下文），失败/不支持则隐藏 textarea + execCommand 兜底
export function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).catch(() => execCopy(t));
  else execCopy(t);
}
export function execCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.top = '-1000px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

// 引用核验徽标落地：把 verifyBadgeHTML 结果挂到回答末尾、反馈条之前（无引用则不显示）
export function appendVerify(div, verify) {
  const html = verifyBadgeHTML(verify);
  if (!html) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  if (wrap.firstChild) div.appendChild(wrap.firstChild);
}
