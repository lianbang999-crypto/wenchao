import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';

function database(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  function prepare(query) {
    const stmt = sql.prepare(query);
    const bound = args => ({
      bind: (...values) => bound(values),
      all: async () => ({ results: stmt.all(...args) }),
      first: async () => stmt.get(...args),
      run: async () => stmt.run(...args),
    });
    return bound([]);
  }
  return { sql, DB: { exec: async q => sql.exec(q), prepare, batch: async statements => Promise.all(statements.map(s => s.run())) } };
}
const articles = {
  'jx-001': { id: 'jx-001', title: '信愿行', segments: [
    { orig: ['念佛贵在真信切愿。', '念佛须专心。'], trans: ['应当真诚相信恳切发愿。'] },
  ] },
  'jx-002': { id: 'jx-002', title: '第二篇', segments: [{ orig: ['唯说持名。示例 abcdef。'], trans: ['念佛需要专心。'] }] },
  'jx-003': { id: 'jx-003', title: '念佛方法', segments: [{ orig: ['应当持名。示例 abc。'], trans: ['持名方法。'] }] },
};
function setup(t) {
  const { sql, DB } = database(t);
  const env = { DB, INDEX_SECRET: 'fixture-secret' };
  const original = globalThis.fetch;
  const failures = new Set();
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path === '/data/books.json') return Response.json([{ juans: [{ cats: [{ items: Object.keys(articles).map(id => ({ id })) }] }] }]);
    const id = path.split('/').pop().replace('.json', '');
    return failures.has(id) ? new Response('missing', { status: 404 }) : Response.json(articles[id]);
  };
  t.after(() => { globalThis.fetch = original; });
  const index = async (cursor = 0) => worker.fetch(new Request(`https://worker.test/index?lexOnly=1&limit=1&cursor=${cursor}`, {
    method: 'POST', headers: { 'X-Index-Secret': 'fixture-secret' },
  }), env, {});
  const search = async body => worker.fetch(new Request('https://worker.test/search', {
    method: 'POST', headers: { Origin: 'https://wenchao.foyue.org', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, {});
  return { sql, index, search, failures };
}
async function build(fx) {
  for (let i = 0; i < 3; i++) {
    const response = await fx.index(i);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.searchReady, i === 2);
  }
}
test('real SQLite search separates text layers and counts distinct articles before pagination', async t => {
  const fx = setup(t); await build(fx);
  for (const [scope, ids] of [['orig', ['jx-001']], ['trans', ['jx-002']], ['title', ['jx-003']], ['all', ['jx-001','jx-002','jx-003']]]) {
    const result = await (await fx.search({ q: '念佛', scope })).json();
    assert.equal(result.ready, true);
    assert.deepEqual(result.hits.map(r => r.i), ids);
    assert.equal(result.total, ids.length);
  }
  const result = await (await fx.search({ q: '念佛', scope: 'all', limit: 1, offset: 1 })).json();
  assert.equal(result.total, 3);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].i, 'jx-002');
  assert.equal(result.hasMore, true); assert.equal(result.nextOffset, 2);
  const literal = await (await fx.search({ q: '%', scope: 'orig' })).json();
  assert.equal(literal.total, 0);
  const latin = await (await fx.search({ q: 'abc', scope: 'orig' })).json();
  assert.equal(latin.total, 2); // FTS 整词命中不能漏掉更长英文词中的字面命中
  assert.equal((await fx.search({ q: '念佛', scope: 'unknown' })).status, 400);
});

test('missing, interrupted and out of order index builds cannot report a complete scoped search', async t => {
  const fx = setup(t);
  assert.equal((await (await fx.search({ q: '念佛', scope: 'orig' })).json()).ready, false);
  assert.equal((await fx.index(0)).status, 200);
  assert.equal((await fx.index(2)).status, 409);
  assert.equal((await (await fx.search({ q: '念佛', scope: 'orig' })).json()).ready, false);
  fx.failures.add('jx-002');
  assert.equal((await fx.index(1)).status, 503);
  assert.equal((await fx.index(2)).status, 409);
  fx.failures.clear(); await build(fx);
  assert.equal((await (await fx.search({ q: '念佛', scope: 'orig' })).json()).ready, true);
});
