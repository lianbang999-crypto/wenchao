import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.js';

const question = '念佛如何修持？';
const source = {
  cid: 'source-1',
  text: '念佛贵在真信切愿，持名求生西方。',
  ctx: '念佛贵在真信切愿，持名求生西方。',
  aid: 'article-1',
  title: '复某居士书',
  vol: 'zeng1',
  volName: '增广文钞',
  sourceType: 'primary',
  pIndex: 0,
  paraIndex: 0,
  seg: 0,
  part: 0,
  url: '/a/article-1/?p=0',
  origKey: '念佛贵在真信切愿',
};

function fixture({ lexicalRows, vectorMatches = [] } = {}) {
  const cacheWrites = [];
  const background = [];
  const kv = new Map();
  const kvWrites = [];
  const ftsMatches = [];
  const env = {
    SILICONFLOW_API_KEY: 'test-key',
    RL: {
      get: async (key) => kv.get(key) ?? null,
      put: async (key, value, options) => {
        kv.set(key, value);
        kvWrites.push([key, value, options]);
        if (String(key).startsWith('a:')) cacheWrites.push([key, value, options]);
      },
    },
    VEC: { query: async () => ({ matches: vectorMatches }) },
  };
  if (lexicalRows !== undefined) {
    env.DB = {
      prepare(sql) {
        let binds = [];
        return {
          bind(...args) { binds = args; return this; },
          async all() {
            if (sql.includes('FROM chunks_fts') && sql.includes('MATCH')) ftsMatches.push(binds[0]);
            return { results: sql.includes('FROM chunks_fts') ? lexicalRows : [] };
          },
          async run() { return { success: true }; },
        };
      },
    };
  }
  const ctx = { waitUntil(promise) { background.push(promise); } };
  return { env, ctx, kv, kvWrites, ftsMatches, cacheWrites, settle: () => Promise.all(background) };
}

function sse(content, complete = true) {
  const delta = JSON.stringify({ choices: [{ delta: { content } }] });
  return new Response(`data: ${delta}\n\n${complete ? 'data: [DONE]\n\n' : ''}`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sseAtTokenLimit(content) {
  const delta = JSON.stringify({ choices: [{ delta: { content } }] });
  const stop = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] });
  return new Response(`data: ${delta}\n\ndata: ${stop}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function mockUpstream(t, {
  embeddingFails = false,
  embeddingStatus = null,
  generation = () => sse('念佛贵在真信切愿。[1]'),
  officialGeneration = () => new Response('official unavailable', { status: 503 }),
} = {}) {
  const originalFetch = globalThis.fetch;
  const calls = {
    embeddings: 0, rewrites: 0, generation: 0, generationBodies: [],
    officialGeneration: 0, officialBodies: [], officialAuthorization: [],
  };
  globalThis.fetch = async (url, options) => {
    const endpoint = String(url);
    if (endpoint.includes('api.deepseek.com') && endpoint.endsWith('/chat/completions')) {
      calls.officialGeneration++;
      calls.officialBodies.push(JSON.parse(options.body));
      calls.officialAuthorization.push(options.headers.Authorization);
      return officialGeneration();
    }
    if (endpoint.endsWith('/embeddings')) {
      calls.embeddings++;
      if (embeddingStatus != null) return new Response('embedding unavailable', { status: embeddingStatus });
      if (embeddingFails) return new Response('quota exceeded', { status: 429 });
      const inputs = JSON.parse(options.body).input;
      return Response.json({ data: inputs.map((_, index) => ({ index, embedding: Array(1024).fill(0) })) });
    }
    if (endpoint.endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (!body.stream) {
        calls.rewrites++;
        return new Response('rewrite unavailable', { status: 503 });
      }
      calls.generation++;
      calls.generationBodies.push(body);
      return generation();
    }
    if (endpoint.endsWith('/rerank')) return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
    throw new Error(`Unexpected upstream endpoint: ${endpoint}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return calls;
}

async function ask(fx, askedQuestion = question) {
  const req = new Request('https://worker.test/api/ai/ask', {
    method: 'POST',
    headers: { Origin: 'https://wenchao.foyue.org', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: askedQuestion }] }),
  });
  const response = await worker.fetch(req, fx.env, fx.ctx);
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  await fx.settle();
  return {
    events,
    meta: events.find((event) => event.type === 'meta'),
    reply: events.filter((event) => event.type === 'delta').map((event) => event.text).join(''),
    done: events.find((event) => event.type === 'done'),
  };
}

test('embedding failure retains D1 source passages and can give a cited reply', async (t) => {
  const fx = fixture({ lexicalRows: [source] });
  const calls = mockUpstream(t, { embeddingFails: true });
  const result = await ask(fx);

  assert.equal(calls.embeddings, 1);
  assert.equal(result.meta.passages.length, 1);
  assert.equal(result.meta.passages[0].text, source.text);
  assert.equal(result.meta.passages[0].aid, source.aid);
  assert.equal(result.meta.passages[0].url, source.url);
  assert.equal(result.meta.sources[0].id, source.aid);
  assert.equal(result.meta.sources[0].url, source.url);
  if (calls.generationBodies.length) {
    assert.match(calls.generationBodies[0].messages[0].content, /念佛贵在真信切愿，持名求生西方。/);
  }
  assert.match(result.reply, /真信切愿/);
  assert.match(result.reply, /\[1\]/);
  assert.doesNotMatch(result.reply, /检索服务暂时不可用/);
  assert.ok(result.done);
});

test('embedding failure with no D1 passages reports retrieval failure without generation', async (t) => {
  const fx = fixture({ lexicalRows: [] });
  const calls = mockUpstream(t, { embeddingFails: true });
  const result = await ask(fx);

  assert.deepEqual(result.meta.passages, []);
  assert.match(result.reply, /检索.*(?:不可用|失败)|服务暂时不可用/);
  assert.doesNotMatch(result.reply, /文钞中未见相关开示/);
  assert.equal(calls.generation, 0);
  assert.equal(fx.cacheWrites.length, 0);
});

test('generation HTTP failure does not present its error body as an answer or cache it', async (t) => {
  const match = { id: source.cid, metadata: { ...source } };
  const fx = fixture({ vectorMatches: [match] });
  mockUpstream(t, {
    generation: () => new Response('{"error":"无出处的幽灵结论"}', { status: 429 }),
  });
  const result = await ask(fx);

  assert.equal(result.meta.passages.length, 1);
  assert.match(result.reply, /生成|暂时不可用|失败/);
  assert.match(result.reply, /念佛贵在真信切愿，持名求生西方。/);
  assert.match(result.reply, /\[1\]/);
  assert.doesNotMatch(result.reply, /无出处的幽灵结论|文钞中未见相关开示/);
  assert.equal(fx.cacheWrites.length, 0);
});

test('failed SiliconFlow generation retries official DeepSeek with the same source context', async (t) => {
  const match = { id: source.cid, metadata: { ...source } };
  const fx = fixture({ vectorMatches: [match] });
  fx.env.DEEPSEEK_API_KEY = 'official-test-key';
  const calls = mockUpstream(t, {
    generation: () => new Response('{"error":"SiliconFlow unavailable"}', { status: 429 }),
    officialGeneration: () => sse('念佛贵在真信切愿。[1]'),
  });
  const result = await ask(fx);

  assert.equal(calls.generation, 1);
  assert.equal(calls.officialGeneration, 1);
  assert.equal(calls.officialAuthorization[0], 'Bearer official-test-key');
  assert.equal(calls.officialBodies[0].model, 'deepseek-flash');
  assert.deepEqual(calls.officialBodies[0].thinking, { type: 'disabled' });
  assert.match(calls.officialBodies[0].messages[0].content, /念佛贵在真信切愿，持名求生西方。/);
  assert.equal(result.meta.passages[0].text, source.text);
  assert.match(result.reply, /真信切愿。\[1\]/);
  assert.ok(result.done);
});

test('both generation providers failing returns only cited source excerpt and no cached answer', async (t) => {
  const match = { id: source.cid, metadata: { ...source } };
  const fx = fixture({ vectorMatches: [match] });
  fx.env.DEEPSEEK_API_KEY = 'official-test-key';
  const calls = mockUpstream(t, {
    generation: () => new Response('{"error":"无出处的幽灵结论 A"}', { status: 429 }),
    officialGeneration: () => new Response('{"error":"无出处的幽灵结论 B"}', { status: 503 }),
  });
  const result = await ask(fx);

  assert.equal(calls.generation, 1);
  assert.equal(calls.officialGeneration, 1);
  assert.equal(result.meta.passages[0].text, source.text);
  assert.match(result.reply, /生成|暂时不可用|失败/);
  assert.match(result.reply, /念佛贵在真信切愿，持名求生西方。/);
  assert.match(result.reply, /\[1\]/);
  assert.doesNotMatch(result.reply, /幽灵结论|文钞中未见相关开示/);
  assert.equal(fx.cacheWrites.length, 0);
});

test('generation stream ending without DONE never caches its partial answer', async (t) => {
  const match = { id: source.cid, metadata: { ...source } };
  const fx = fixture({ vectorMatches: [match] });
  mockUpstream(t, { generation: () => sse('未完成的回答。[1]', false) });
  const result = await ask(fx);

  assert.equal(result.meta.passages.length, 1);
  assert.match(result.reply, /中断|不完整|失败/);
  assert.equal(result.done.verify, null);
  assert.equal(fx.cacheWrites.length, 0);
});

test('DeepSeek finish_reason length marks the answer incomplete and avoids caching', async (t) => {
  const match = { id: source.cid, metadata: { ...source } };
  const fx = fixture({ vectorMatches: [match] });
  fx.env.DEEPSEEK_API_KEY = 'official-test-key';
  const calls = mockUpstream(t, {
    generation: () => new Response('SiliconFlow unavailable', { status: 520 }),
    officialGeneration: () => sseAtTokenLimit('念佛贵在真信切愿。[1]'),
  });
  const result = await ask(fx);

  assert.equal(calls.officialGeneration, 1);
  assert.deepEqual(calls.officialBodies[0].thinking, { type: 'disabled' });
  assert.match(result.reply, /念佛贵在真信切愿。\[1\]/);
  assert.match(result.reply, /未完成|不完整/);
  assert.equal(result.done.verify, null);
  assert.equal(fx.cacheWrites.length, 0);
});

test('D1 fallback searches 念佛 without site name or generic 看待 phrase', async (t) => {
  const fx = fixture({ lexicalRows: [source] });
  mockUpstream(t, { embeddingStatus: 402 });
  const result = await ask(fx, '印光法师如何看待念佛？');

  assert.equal(result.meta.passages[0].text, source.text);
  assert.ok(fx.ftsMatches.length > 0);
  const match = fx.ftsMatches.at(-1);
  assert.match(match, /念佛/);
  assert.doesNotMatch(match, /印光|光法|法师|看待|待念/);
});

test('an embeddings 402 opens a five minute circuit for the next distinct question', async (t) => {
  const fx = fixture({ lexicalRows: [source] });
  fx.env.DEEPSEEK_API_KEY = 'official-test-key';
  const calls = mockUpstream(t, {
    embeddingStatus: 402,
    generation: () => new Response('SiliconFlow unavailable', { status: 520 }),
    officialGeneration: () => sse('念佛贵在真信切愿。[1]'),
  });

  const first = await ask(fx, '印光法师如何看待念佛？');
  assert.equal(first.meta.passages[0].text, source.text);
  assert.equal(calls.embeddings, 1);
  assert.ok(fx.kvWrites.some(([, , options]) => options?.expirationTtl === 300));
  const beforeSecond = {
    rewrites: calls.rewrites,
    embeddings: calls.embeddings,
    siliconflowChat: calls.generation,
    officialChat: calls.officialGeneration,
  };

  const second = await ask(fx, '印光法师如何看待持名？');
  assert.equal(second.meta.passages[0].text, source.text);
  assert.match(second.reply, /\[1\]/);
  assert.equal(calls.rewrites, beforeSecond.rewrites);
  assert.equal(calls.embeddings, beforeSecond.embeddings);
  assert.equal(calls.generation, beforeSecond.siliconflowChat);
  assert.equal(calls.officialGeneration, beforeSecond.officialChat + 1);
});

for (const [label, reply] of [
  ['out of range', '据文而答。[99]'],
  ['zero citation', '据文而答。[0]'],
  ['invented direct quote', '「念一声就能获得一切」[1]'],
  ['uncited direct quote', '「念佛贵在真信切愿」故应精进。[1]'],
  ['missing citations', '应当精进修持。'],
  ['single character quote', '『错』[1]'],
]) test(`${label} is never saved as a reusable answer`, async t => {
  const fx = fixture({ lexicalRows: [source] });
  mockUpstream(t, { generation: () => sse(reply) });
  const result = await ask(fx);
  assert.equal(result.done.verify.faithful, false);
  assert.equal(fx.cacheWrites.length, 0);
});

test('translation cannot pass as a direct original quote', async t => {
  const fx = fixture({ lexicalRows: [{ ...source, ctx: source.ctx + '\n（白话）必须真诚相信恳切发愿。' }] });
  mockUpstream(t, { generation: () => sse('「必须真诚相信恳切发愿」[1]') });
  const result = await ask(fx);
  assert.equal(result.done.verify.quoteOk, 0);
  assert.equal(result.done.verify.faithful, false);
  assert.equal(fx.cacheWrites.length, 0);
});

test('validated cache preserves parent evidence and returns the same verification without regeneration', async t => {
  const fx = fixture({ lexicalRows: [{ ...source, text: '念佛贵在真信切愿。', ctx: source.ctx }] });
  const calls = mockUpstream(t, { generation: () => sse('「持名求生西方」[1]') });
  const first = await ask(fx);
  assert.equal(first.done.verify.faithful, true);
  assert.equal(first.done.verify.quoteOk, 1);
  assert.equal(fx.cacheWrites.length, 1);
  const second = await ask(fx);
  assert.deepEqual(second.done.verify, first.done.verify);
  assert.equal(second.reply, first.reply);
  assert.equal(calls.generation, 1);
  assert.deepEqual(JSON.parse(fx.cacheWrites[0][1]).ctxTexts, [source.ctx]);
});

test('legacy cache without evidence and a tampered cache are both regenerated', async t => {
  const fx = fixture({ lexicalRows: [source] });
  const calls = mockUpstream(t, { generation: () => sse('「持名求生西方」[1]') });
  await ask(fx);
  const key = fx.cacheWrites[0][0];
  const legacy = JSON.parse(fx.kv.get(key));
  delete legacy.ctxTexts;
  fx.kv.set(key, JSON.stringify(legacy));
  await ask(fx);
  assert.equal(calls.generation, 2);
  const tampered = JSON.parse(fx.kv.get(key));
  tampered.reply = '「凭空添加的语句」[1]';
  fx.kv.set(key, JSON.stringify(tampered));
  const result = await ask(fx);
  assert.equal(calls.generation, 3);
  assert.equal(result.done.verify.faithful, true);
});
