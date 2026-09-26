/* 阅读记录备份：只处理明确列出的阅读数据，不导入设置、对话或任意存储键。 */
const FORMAT = 'wenchao-reading-records';
const ID = /^[a-z0-9]+-\d{3}$/;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v, max) => typeof v === 'string' && v.length <= max;
const fail = () => { throw new Error('备份内容不完整或格式不正确，未导入任何记录。'); };

export function collectReadingData(storage) {
  const read = (k, fallback) => {
    const raw = storage.getItem('wc.' + k);
    return raw === null ? fallback : JSON.parse(raw);
  };
  const highlights = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith('wc.hl.') && ID.test(key.slice(6))) {
      highlights[key.slice(6)] = JSON.parse(storage.getItem(key));
    }
  }
  return { bookmarks: read('bookmarks', {}), progress: read('progress', {}),
    lastRead: read('lastRead', null), highlights };
}

export function makeReadingBackup(data) {
  return JSON.stringify({ format: FORMAT, version: 1, exportedAt: new Date().toISOString(), data }, null, 2);
}

// 勘误或重新分段后，以保存的摘句复核位置；仅在唯一命中时迁移，避免划错经文。
export function locateHighlight(h, paragraphs, normalize = (s) => s) {
  if (!h.t) return null;
  const quote = normalize(h.t), length = h.e - h.s;
  const matches = [];
  for (let p = 0; p < paragraphs.length; p++) {
    const text = normalize(paragraphs[p]);
    if (p === h.p && h.e <= text.length && text.slice(h.s, h.s + quote.length) === quote) return h;
    let s = text.indexOf(quote);
    while (s >= 0) {
      if (s + length <= text.length) matches.push({ p, s, e: s + length });
      s = text.indexOf(quote, s + 1);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function parseReadingBackup(raw, validIds) {
  if (typeof raw !== 'string' || raw.length > 10 * 1024 * 1024) fail();
  let doc; try { doc = JSON.parse(raw); } catch (e) { fail(); }
  if (!object(doc) || doc.format !== FORMAT || doc.version !== 1 || !object(doc.data)) fail();
  const src = doc.data;
  const out = { bookmarks: {}, progress: {}, lastRead: null, highlights: {} };
  const skippedIds = new Set();
  let highlights = 0;
  function each(map, target, validate) {
    if (!object(map) || Object.keys(map).length > 10000) fail();
    for (const id of Object.keys(map)) {
      if (!ID.test(id)) fail();
      const value = validate(map[id]);
      if (validIds && !validIds.has(id)) { skippedIds.add(id); continue; }
      target[id] = value;
    }
  }
  each(src.bookmarks, out.bookmarks, (v) => {
    if (!object(v) || !text(v.t, 1000) || !text(v.v, 300) || !number(v.ts)) fail();
    return { t: v.t, v: v.v, ts: v.ts };
  });
  each(src.progress, out.progress, (v) => {
    if (!object(v) || !number(v.pct) || v.pct > 1 || !number(v.t)) fail();
    return { pct: v.pct, t: v.t };
  });
  each(src.highlights, out.highlights, (items) => {
    if (!Array.isArray(items) || (highlights += items.length) > 50000) fail();
    return items.map((v) => {
      if (!object(v) || !Number.isInteger(v.p) || v.p < 0 || v.p > 100000 ||
          !Number.isInteger(v.s) || v.s < 0 || !Number.isInteger(v.e) || v.e <= v.s ||
          v.e > 1000000 || !text(v.t, 10000)) fail();
      return { p: v.p, s: v.s, e: v.e, t: v.t };
    });
  });
  if (src.lastRead !== null) {
    const v = src.lastRead;
    if (!object(v) || !ID.test(v.id) || !text(v.title, 1000)) fail();
    if (!validIds || validIds.has(v.id)) out.lastRead = { id: v.id, title: v.title };
    else skippedIds.add(v.id);
  }
  return { data: out, skipped: skippedIds.size };
}

export function mergeReadingData(local, incoming) {
  const bookmarks = { ...local.bookmarks }, progress = { ...local.progress };
  const highlights = { ...local.highlights };
  for (const id of Object.keys(incoming.bookmarks)) {
    if (!own(bookmarks, id) || incoming.bookmarks[id].ts > bookmarks[id].ts) bookmarks[id] = incoming.bookmarks[id];
  }
  for (const id of Object.keys(incoming.progress)) {
    if (!own(progress, id) || incoming.progress[id].t > progress[id].t) progress[id] = incoming.progress[id];
  }
  for (const id of Object.keys(incoming.highlights)) {
    const seen = new Set();
    highlights[id] = (highlights[id] || []).concat(incoming.highlights[id]).filter((h) => {
      const key = [h.p, h.s, h.e, h.t].join('\u0000');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).sort((a, b) => a.p - b.p || a.s - b.s);
  }
  const latest = Object.keys(progress).sort((a, b) => progress[b].t - progress[a].t)[0];
  let lastRead = local.lastRead || incoming.lastRead;
  if (latest && incoming.lastRead && latest === incoming.lastRead.id) lastRead = incoming.lastRead;
  return { bookmarks, progress, highlights, lastRead };
}

export function applyReadingData(storage, data) {
  const writes = [['wc.bookmarks', data.bookmarks], ['wc.progress', data.progress], ['wc.lastRead', data.lastRead]];
  for (const id of Object.keys(data.highlights)) writes.push(['wc.hl.' + id, data.highlights[id]]);
  const before = writes.map(([key]) => [key, storage.getItem(key)]);
  let written = 0;
  try {
    for (const [key, value] of writes) { storage.setItem(key, JSON.stringify(value)); written++; }
  } catch (e) {
    // 配额失败时回滚已写的键。存储整体被禁用时仍明确报失败，不给出成功提示。
    for (let i = written - 1; i >= 0; i--) {
      try { const [key, value] = before[i]; if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch (ignored) {}
    }
    throw new Error('导入未完成，设备存储空间不足或不允许保存。请保留备份文件后重试。');
  }
}
