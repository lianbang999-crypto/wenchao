/* 印光法师文钞 · 知识库问答（基于全文钞的 NotebookLM）
 *
 * 架构（全在 Cloudflare）：
 *   建库(一次)：/index 批量抓全站文章 → 切段 → Workers AI(bge-m3) 向量 → 存入 Vectorize
 *   提问：问题 → 向量 → Vectorize 检索最相关段 → DeepSeek 据此作答(标出处·限字数)
 *   缓存：① 向量库本身(建一次长期用) ② 答案缓存(同问秒回,KV) ③ DeepSeek 前缀自动缓存
 *
 * 前端契约：POST { messages:[{role,content}…], articleId? } → { reply, cite, sources:[{id,title}] }
 *
 * 绑定(见 wrangler.toml)：AI(Workers AI)、VEC(Vectorize)、RL(KV 限流+答案缓存)
 * 密钥(Secret)：DEEPSEEK_API_KEY、INDEX_SECRET(保护 /index)
 *
 * 建库：部署后调用（分批，循环到 done:true）
 *   curl -X POST "https://<worker>/index?cursor=0" -H "X-Index-Secret: <INDEX_SECRET>"
 */

const ALLOW_ORIGINS = [
  'https://wenchao.foyue.org',
  'https://wenchao.pages.dev',
  'http://localhost:4188',
  'http://127.0.0.1:4188',
];
const SITE_BASE = 'https://wenchao.foyue.org';
const EMBED_MODEL = '@cf/baai/bge-m3';   // 多语种向量(含古今汉语)，1024 维
const CHAT_MODEL = 'deepseek-chat';
const TOP_K = 8;                          // 检索段数
const ANSWER_CHARS = 500;                 // 回复字数上限(软引导)
const MAX_TOKENS = 700;                   // 回复 token 硬上限(约 500 汉字)
const CACHE_TTL = 7 * 86400;              // 答案缓存 7 天
const DAILY_LIMIT = 60;                   // 每 IP 每日提问上限
const INDEX_BATCH = 25;                   // 每次 /index 处理的文章数
const META_TEXT_MAX = 900;               // 存入向量库的段落文本上限

function cors(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers });

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function embed(env, texts) {
  const r = await env.AI.run(EMBED_MODEL, { text: texts });
  return r.data;   // [[...1024], …]
}

/* ---------- 建库：把一篇切成「原文(+白话)」段块 ---------- */
function chunksOf(art) {
  const out = [];
  (art.segments || []).forEach((s, i) => {
    const orig = (s.orig || []).join('');
    const trans = (s.trans || []).join('');
    const plain = s.o || '';
    const body = orig || plain;
    if (!body) return;
    let text = body;
    if (trans) text += '\n（白话）' + trans;
    out.push({
      id: `${art.id}#${i}`,
      text: text.slice(0, META_TEXT_MAX),
      meta: { aid: art.id, title: art.title || '', vol: art.volumeName || '', seg: i },
    });
  });
  return out;
}

async function handleIndex(req, env, url, headers) {
  const indexSecret = req.headers.get('X-Index-Secret') ||
    (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.INDEX_SECRET || indexSecret !== env.INDEX_SECRET) {
    return json({ error: 'forbidden' }, 403, headers);
  }
  const cursor = parseInt(url.searchParams.get('cursor') || '0', 10);
  const books = await (await fetch(`${SITE_BASE}/data/books.json`)).json();
  const ids = [];
  for (const b of books)
    for (const j of b.juans)
      for (const c of j.cats)
        for (const it of c.items) ids.push(it.id);

  const batch = ids.slice(cursor, cursor + INDEX_BATCH);
  let chunks = [];
  for (const id of batch) {
    try {
      const a = await (await fetch(`${SITE_BASE}/data/articles/${id}.json`)).json();
      chunks = chunks.concat(chunksOf(a));
    } catch { /* 跳过取不到的篇 */ }
  }
  // 分小批向量化并写入(bge-m3 单次建议 ≤ ~100 条)
  let n = 0;
  for (let i = 0; i < chunks.length; i += 50) {
    const part = chunks.slice(i, i + 50);
    const vecs = await embed(env, part.map((c) => c.text));
    await env.VEC.upsert(part.map((c, k) => ({
      id: c.id, values: vecs[k], metadata: { ...c.meta, text: c.text },
    })));
    n += part.length;
  }
  const next = cursor + INDEX_BATCH;
  return json({ ok: true, indexedArticles: batch.length, chunks: n,
    cursor: next, done: next >= ids.length, total: ids.length }, 200, headers);
}

/* ---------- 提问：检索 + DeepSeek ---------- */
async function handleAsk(req, env, headers) {
  if (!env.DEEPSEEK_API_KEY) return json({ reply: '服务未配置密钥。' }, 500, headers);

  // 限流
  if (env.RL) {
    const ip = req.headers.get('CF-Connecting-IP') || 'anon';
    const key = `d:${new Date().toISOString().slice(0, 10)}:${ip}`;
    const c = parseInt((await env.RL.get(key)) || '0', 10);
    if (c >= DAILY_LIMIT) return json({ reply: '今日提问已达上限，请明日再来。阿弥陀佛。' }, 429, headers);
    await env.RL.put(key, String(c + 1), { expirationTtl: 90000 });
  }

  let body;
  try { body = await req.json(); } catch { body = null; }
  const msgs = body && Array.isArray(body.messages)
    ? body.messages.filter((m) => m && m.role && typeof m.content === 'string').slice(-6) : [];
  const question = msgs.length ? msgs[msgs.length - 1].content : '';
  if (!question.trim()) return json({ reply: '请输入问题。' }, 400, headers);

  // 答案缓存（同问秒回）
  const ckey = 'a:' + (await sha256(question.trim()));
  if (env.RL) {
    const hit = await env.RL.get(ckey);
    if (hit) return json(JSON.parse(hit), 200, headers);
  }

  // 检索
  let matches = [];
  try {
    const [qv] = await embed(env, [question]);
    const res = await env.VEC.query(qv, { topK: TOP_K, returnMetadata: 'all' });
    matches = res.matches || [];
  } catch { /* 检索失败则裸答（仍受系统提示约束） */ }

  const ctxBlocks = [], srcMap = new Map();
  matches.forEach((m, i) => {
    const md = m.metadata || {};
    ctxBlocks.push(`【资料${i + 1}·《${md.title || ''}》】${md.text || ''}`);
    if (md.aid && !srcMap.has(md.aid)) srcMap.set(md.aid, md.title || '');
  });
  const sources = [...srcMap].slice(0, 6).map(([id, title]) => ({ id, title }));
  const context = ctxBlocks.join('\n\n') || '（未检索到相关资料）';

  const system = `你是「印光法师文钞」知识库助手，依据检索到的文钞资料回答净土学修问题。务必：
1. 只依据下面【资料】作答；资料里有的如实答、可引用原文；资料里没有或问题与文钞/净土无关，就说「文钞中未见相关开示」，不要编造。
2. 不扮演佛菩萨或祖师口吻，不预言吉凶、不轻下因果定论；语气恭敬平实。
3. 简明扼要，控制在约 ${ANSWER_CHARS} 字以内。

【资料】
${context}`;

  let ds;
  try {
    ds = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: 'system', content: system }, ...msgs],
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
    });
  } catch { return json({ reply: '上游服务连接失败，请稍后重试。' }, 502, headers); }
  if (!ds.ok) return json({ reply: '上游服务繁忙，请稍后重试。' }, 502, headers);

  const data = await ds.json();
  const reply = ((data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.content) || '').trim() || '（无回复）';
  const cite = sources.length ? '参见：' + sources.map((s) => `《${s.title}》`).join('、') : '仅供参考，义理以大师原文为准';
  const payload = { reply, cite, sources };
  if (env.RL) await env.RL.put(ckey, JSON.stringify(payload), { expirationTtl: CACHE_TTL });
  return json(payload, 200, headers);
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const headers = { 'Content-Type': 'application/json', ...cors(origin) };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers });
    const url = new URL(req.url);
    if (url.pathname === '/index') return handleIndex(req, env, url, headers);
    return handleAsk(req, env, headers);
  },
};
