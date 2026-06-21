/* 印光法师文钞 · AI 助读「共享内核」
 * 抽屉(app.js)与独立页(ask.js)共用的纯逻辑，避免两处重复维护。
 * 只含与具体页面 DOM 无关的部分：HTML 转义、回答排版(轻量 Markdown + 角标)、
 * 出处摘录、流式问答、反馈上报、本地会话存储(与抽屉同源同键，故同设备会话天然互通)。 */

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* 本地存储：与 app.js 的 store 同前缀(wc.)、同键(aiSession)，
 * 因而同一设备同一浏览器下，抽屉与独立页的会话历史天然互通。 */
export const lstore = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('wc.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wc.' + k, JSON.stringify(v)); } catch {} },
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
  const { onMeta, onDelta } = handlers || {};
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal,
  });
  let full = '';
  const onMsg = (m) => {
    if (!m) return;
    if (m.type === 'meta') { if (onMeta) onMeta(m.passages || [], m.sources || [], m.cite || ''); }
    else if (m.type === 'delta') { full += m.text || ''; if (onDelta) onDelta(full, m.text || ''); }
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
        if (line) try { onMsg(JSON.parse(line)); } catch { /* 半行 */ }
      }
    }
    if (buf.trim()) try { onMsg(JSON.parse(buf.trim())); } catch { /* 末行无换行的 {reply} 错误体 */ }
  } else {                                              // 不支持流式：整体读取
    (await res.text()).split('\n').forEach((l) => { if (l.trim()) try { onMsg(JSON.parse(l)); } catch {} });
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
