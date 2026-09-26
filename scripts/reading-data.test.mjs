import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReadingData, makeReadingBackup, parseReadingBackup, mergeReadingData, applyReadingData } from '../site/js/reading-data.js';

const empty = () => ({ bookmarks: {}, progress: {}, lastRead: null, highlights: {} });
function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i],
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
}
const sample = () => ({ bookmarks: { 'jx-051': { t: '一函遍复', v: '精选', ts: 20 } },
  progress: { 'jx-051': { pct: .4, t: 20 } }, lastRead: { id: 'jx-051', title: '一函遍复' },
  highlights: { 'jx-051': [{ p: 2, s: 0, e: 4, t: '净土法门' }] } });

test('backup round trip includes all reading data and excludes conversations/settings', () => {
  const s = storage({ 'wc.aiSession': 'private conversation', 'wc.theme': 'night' });
  applyReadingData(s, sample());
  const raw = makeReadingBackup(collectReadingData(s));
  assert.doesNotMatch(raw, /conversation|theme|aiSession/);
  assert.deepEqual(parseReadingBackup(raw).data, sample());
});
test('import merges newer progress and bookmarks, preserves unrelated records and deduplicates highlights', () => {
  const local = sample(), incoming = sample();
  incoming.progress['jx-051'] = { pct: .8, t: 10 }; // older progress must not overwrite
  incoming.bookmarks['jx-010'] = { t: '与陈锡周居士书', v: '精选', ts: 30 };
  const merged = mergeReadingData(local, incoming);
  assert.equal(merged.progress['jx-051'].pct, .4);
  assert.equal(Object.keys(merged.bookmarks).length, 2);
  assert.equal(merged.highlights['jx-051'].length, 1);
  assert.deepEqual(local, sample());
});
test('invalid schema, unsafe keys and malformed ranges are rejected before storage writes', () => {
  for (const raw of ['{}', '{', '{"format":"wenchao-reading-records","version":9,"data":{}}']) assert.throws(() => parseReadingBackup(raw));
  const data = sample(); data.highlights['jx-051'][0].e = -1;
  assert.throws(() => parseReadingBackup(makeReadingBackup(data)));
  const hostile = makeReadingBackup(empty()).replace('"bookmarks": {}', '"bookmarks": {"__proto__": {}}');
  assert.throws(() => parseReadingBackup(hostile));
});
test('unknown articles are skipped without changing valid ones', () => {
  const parsed = parseReadingBackup(makeReadingBackup(sample()), new Set(['jx-010']));
  assert.equal(parsed.skipped, 1); assert.deepEqual(parsed.data, empty());
});
test('quota failure rolls back a partially applied import', () => {
  const s = storage(); applyReadingData(s, sample()); const before = [...s.map];
  const write = s.setItem; let n = 0;
  s.setItem = (k, v) => { if (++n === 3) throw new Error('QuotaExceededError'); return write(k, v); };
  const next = sample(); next.bookmarks['jx-010'] = { t: 'new', v: '', ts: 30 }; next.progress['jx-051'].pct = .9;
  assert.throws(() => applyReadingData(s, next), /导入未完成/);
  assert.deepEqual([...s.map], before);
});

test('corrected paragraph order reanchors unique saved text and never marks unrelated text', async () => {
  const { locateHighlight } = await import('../site/js/reading-data.js');
  const h = { p: 0, s: 0, e: 6, t: '念佛贵在真信' };
  assert.deepEqual(locateHighlight(h, ['新增分则标题', '念佛贵在真信切愿。']), { p: 1, s: 0, e: 6 });
  assert.equal(locateHighlight(h, ['完全不同的内容。']), null);
  assert.equal(locateHighlight(h, ['新增分则标题', '念佛贵在真信切愿。', '念佛贵在真信切愿。']), null);
});
