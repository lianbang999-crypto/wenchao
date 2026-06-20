/* 印光法师文钞 · 知识库问答（基于全文钞的 NotebookLM）
 *
 * 架构（全在 Cloudflare）：
 *   建库(一次)：/index 批量抓全站文章 → 切段 → Workers AI(bge-m3) 向量 → 存入 Vectorize
 *   提问：问题 →(可选)文言改写多查询 → 向量 → Vectorize 召回 → 交叉编码器重排序 → DeepSeek 据最相关段作答(标出处·限字数)
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
  'https://www.wenchao.foyue.org',
  'https://wenchao.pages.dev',
  'http://localhost:4188',
  'http://127.0.0.1:4188',
];
const SITE_BASE = 'https://wenchao.foyue.org';
const EMBED_MODEL = '@cf/baai/bge-m3';   // 多语种向量(含古今汉语)，1024 维
const CHAT_MODEL = 'deepseek-chat';
const KB_NAMESPACE = 'v2';                // 优化后的知识库命名空间；默认 namespace 保留作回退
const TOP_K = 8;                          // 喂给 DeepSeek 的最终段数
const RERANK_MODEL = '@cf/baai/bge-reranker-base'; // 交叉编码器重排序，提升检索精度
const RERANK_POOL = 24;                    // 去重后送入重排序的候选段上限
const USE_RERANK = true;                   // 重排序总开关（异常时可一键回退纯向量序）
const USE_QUERY_REWRITE = true;            // 多查询：原问 + DeepSeek 文言改写检索式
const RETRIEVAL_VERSION = 'r2';            // 检索逻辑版本号，并入答案缓存键，避免旧缓存遮蔽新检索
const ANSWER_CHARS = 500;                 // 回复字数上限(软引导)
const MAX_TOKENS = 700;                   // 回复 token 硬上限(约 500 汉字)
const CACHE_TTL = 7 * 86400;              // 答案缓存 7 天
const DAILY_LIMIT = 60;                   // 每 IP 每日提问上限
const INDEX_BATCH = 25;                   // 每次 /index 处理的文章数
const INDEX_EMBED_BATCH = 50;             // 每次 Workers AI embedding 文本数
const CHUNK_CHARS = 720;                  // 单个向量块目标字数，避免长段被截断
const CHUNK_OVERLAP = 80;                 // 长段切块重叠，保留上下文

function cors(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function articlePath(id, pIndex) {
  const p = Number.isFinite(Number(pIndex)) && Number(pIndex) >= 0
    ? `?p=${Number(pIndex)}`
    : '';
  return `/a/${encodeURIComponent(id)}/${p}`;
}
function sourceTypeOf(art) {
  if (art.volume === 'jx') return 'selected';
  if (art.volume === 'jy') return 'jiayan';
  return 'primary';
}
function sourcePriority(md) {
  if ((md.sourceType || '') === 'primary') return 0;
  if ((md.sourceType || '') === 'jiayan') return 1;
  if ((md.sourceType || '') === 'selected') return 2;
  return 3;
}
function cleanKey(s) {
  return String(s || '').replace(/\s/g, '').slice(0, 80);
}
function splitLongText(text) {
  text = String(text || '').trim();
  if (!text || text.length <= CHUNK_CHARS) return text ? [text] : [];
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const win = text.slice(start, end);
      const cuts = ['。', '；', '！', '？', '\n'].map((c) => win.lastIndexOf(c));
      const cut = Math.max(...cuts);
      if (cut > CHUNK_CHARS * 0.45) end = start + cut + 1;
    }
    const part = text.slice(start, end).trim();
    if (part) out.push(part);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return out;
}

/* ---------- 建库：把一篇按自然段切成「原文(+白话)」段块 ----------
 * migrate 常把整篇并成一个 segment（orig[]/trans[] 各含多段），故须按段拆。
 * v2 不再截断长段，而是按标点切成带 overlap 的子块，并保存可跳转段落 metadata。 */
function chunksOf(art) {
  const out = [];
  let idx = 0;
  let paraIndex = 0;
  let pIndex = 0; // 与前端 p.p-orig / p.p-trans NodeList 下标一致
  const sourceType = sourceTypeOf(art);
  const push = (text, meta) => {
    text = (text || '').trim();
    if (!text) return;
    splitLongText(text).forEach((part, partIdx) => {
      const keyText = (part.split('\n（白话）')[0] || part).replace(/^（白话）/, '');
      out.push({
        id: `${art.id}#${idx}`,
        text: part,
        meta: {
          aid: art.id,
          title: art.title || '',
          vol: art.volume || '',
          volName: art.volumeName || '',
          sourceType,
          seg: idx,
          paraIndex: meta.paraIndex,
          pIndex: meta.pIndex,
          part: partIdx,
          kind: meta.kind || '',
          url: articlePath(art.id, meta.pIndex),
          origKey: cleanKey(keyText || part),
        },
      });
      idx++;
    });
  };
  (art.segments || []).forEach((s) => {
    const O = s.orig || (s.o ? [s.o] : []);
    const T = s.trans || [];
    if (art.plain) {
      O.forEach((p) => {
        push(p, { kind: 'plain', paraIndex, pIndex });
        paraIndex++; pIndex++;
      });
      return;
    }
    if (O.length && O.length === T.length) {        // 对齐：逐段原文+白话成一块
      for (let i = 0; i < O.length; i++) {
        push(O[i] + (T[i] ? '\n（白话）' + T[i] : ''), { kind: 'pair', paraIndex, pIndex });
        paraIndex++; pIndex += 2;
      }
    } else {                                        // 不齐：原文段、白话段各自成块
      O.forEach((p) => {
        push(p, { kind: 'orig', paraIndex, pIndex });
        paraIndex++; pIndex++;
      });
      T.forEach((p) => {
        push('（白话）' + p, { kind: 'trans', paraIndex, pIndex });
        paraIndex++; pIndex++;
      });
    }
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
  const reqLimit = parseInt(url.searchParams.get('limit') || String(INDEX_BATCH), 10);
  const limit = Math.max(1, Math.min(INDEX_BATCH, Number.isFinite(reqLimit) ? reqLimit : INDEX_BATCH));
  const books = await (await fetch(`${SITE_BASE}/data/books.json`)).json();
  const ids = [];
  for (const b of books)
    for (const j of b.juans)
      for (const c of j.cats)
        for (const it of c.items) ids.push(it.id);

  const batch = ids.slice(cursor, cursor + limit);
  let chunks = [];
  for (const id of batch) {
    try {
      const a = await (await fetch(`${SITE_BASE}/data/articles/${id}.json`)).json();
      chunks = chunks.concat(chunksOf(a));
    } catch { /* 跳过取不到的篇 */ }
  }
  // 分小批向量化并写入(bge-m3 单次建议 ≤ ~100 条)
  let n = 0;
  for (let i = 0; i < chunks.length; i += INDEX_EMBED_BATCH) {
    const part = chunks.slice(i, i + INDEX_EMBED_BATCH);
    const vecs = await embed(env, part.map((c) => c.text));
    await env.VEC.upsert(part.map((c, k) => ({
      id: c.id, namespace: KB_NAMESPACE, values: vecs[k], metadata: { ...c.meta, text: c.text },
    })));
    n += part.length;
  }
  const next = cursor + limit;
  return json({ ok: true, indexedArticles: batch.length, chunks: n,
    cursor: next, done: next >= ids.length, total: ids.length, limit, namespace: KB_NAMESPACE }, 200, headers);
}

/* ---------- 提问：检索 + DeepSeek ---------- */
function wantsArticleScope(q) {
  return /本篇|本文|此篇|这篇|這篇|此文|这封|這封|这段|這段|此段|上文|文中|这里|這裡|此处|此處|这一段|這一段/.test(q || '');
}
async function queryKnowledgeBase(env, qv, filter) {
  const topK = Math.min(TOP_K * 3, 20);
  const attempts = [
    { topK, returnMetadata: 'all', namespace: KB_NAMESPACE, ...(filter ? { filter } : {}) },
    { topK, returnMetadata: 'all', namespace: KB_NAMESPACE },
    { topK, returnMetadata: 'all' }, // 回退旧默认 namespace，避免 v2 未建完时线上不可用
  ];
  for (const opts of attempts) {
    try {
      const res = await env.VEC.query(qv, opts);
      if (res && res.matches && res.matches.length) return res.matches;
    } catch { /* 尝试下一种查询策略 */ }
  }
  return [];
}
function dedupeMatches(matches) {
  const byKey = new Map();
  for (const m of matches) {
    const md = m.metadata || {};
    const text = md.text || '';
    const key = md.origKey || cleanKey((text.split('\n（白话）')[0] || text).replace(/^（白话）/, ''));
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev ||
        sourcePriority(md) < sourcePriority(prev.metadata || {}) ||
        (sourcePriority(md) === sourcePriority(prev.metadata || {}) && (m.score || 0) > (prev.score || 0))) {
      byKey.set(key, m);
    }
  }
  return [...byKey.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, RERANK_POOL);
}

/* 多查询：把口语/白话问题改写成更贴近文钞文言、突出名相的检索式，与原问并用以提升召回。
 * best-effort：超时或任何失败都退回只用原问，绝不阻塞问答。 */
async function buildRetrievalQueries(env, q) {
  const queries = [q];
  if (!USE_QUERY_REWRITE || !env.DEEPSEEK_API_KEY) return queries;
  try {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: '你是检索助手。把用户的口语/白话问题改写成一句更贴近《印光法师文钞》文言用语、突出关键名相的检索式；只输出改写后的查询本身，不解释、不加引号，30字以内。' },
          { role: 'user', content: q },
        ],
        temperature: 0, max_tokens: 60, stream: false,
      }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(4500);
    const r = await fetch('https://api.deepseek.com/chat/completions', opts);
    if (r.ok) {
      const j = await r.json();
      const rw = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
        .replace(/^["“”\s]+|["“”\s]+$/g, '').trim();
      if (rw && rw !== q && rw.length <= 60) queries.push(rw);
    }
  } catch { /* 改写失败：仅用原问 */ }
  return queries;
}

/* 合并多路检索结果：按向量 id 取并集，保留每条最高分 */
function mergeMatchPools(pools) {
  const byId = new Map();
  for (const pool of pools)
    for (const m of pool || []) {
      const prev = byId.get(m.id);
      if (!prev || (m.score || 0) > (prev.score || 0)) byId.set(m.id, m);
    }
  return [...byId.values()];
}

/* 交叉编码器重排序：对去重后的候选按与问题的真实相关度重排，仅用于排序、不丢段。
 * best-effort：失败、无评分或模型不可用时保持原向量序，绝不让问答因此中断。 */
async function rerankMatches(env, query, matches) {
  if (!USE_RERANK || !env.AI || matches.length <= 1) return matches;
  const pool = matches.slice(0, RERANK_POOL);
  try {
    const contexts = pool.map((m) => ({ text: (m.metadata && m.metadata.text) || '' }));
    const r = await env.AI.run(RERANK_MODEL, { query, contexts, top_k: pool.length });
    const ranked = (r && (r.response || r.data || r.results)) || null;
    if (Array.isArray(ranked) && ranked.length) {
      const ordered = [], seen = new Set();
      for (const it of ranked) {
        const idx = typeof it.id === 'number' ? it.id
          : (typeof it.index === 'number' ? it.index : -1);
        if (idx >= 0 && idx < pool.length && !seen.has(idx)) {
          seen.add(idx);
          if (typeof it.score === 'number') pool[idx].rerankScore = it.score;
          ordered.push(pool[idx]);
        }
      }
      // 补回重排序结果未覆盖到的候选，保证不丢段、顺序稳定
      pool.forEach((m, i) => { if (!seen.has(i)) ordered.push(m); });
      if (ordered.length) return ordered;
    }
  } catch { /* 重排序失败：退回向量序 */ }
  return pool;
}

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
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const lastU = userMsgs.length ? userMsgs[userMsgs.length - 1].content : '';
  if (!lastU.trim()) return json({ reply: '请输入问题。' }, 400, headers);
  const articleId = body && typeof body.articleId === 'string' ? body.articleId.trim() : '';
  // ② 多轮追问：指代/短问/承上时，并入上一问做检索（否则"出处呢""再展开"会检索不到）
  const prevU = userMsgs.length > 1 ? userMsgs[userMsgs.length - 2].content : '';
  let retrievalQ = lastU;
  if (prevU && (lastU.length < 12 ||
      /它|他|她|这|那|上(面|述|文)|继续|再|还有|为什[么麽]|怎[么样]|出处|展开|具体|详细|例子|呢[？?]?$/.test(lastU))) {
    retrievalQ = prevU + '。' + lastU;
  }

  // 答案缓存：仅单轮问答（多轮依赖上下文，不缓存以免串味）
  const cacheable = userMsgs.length === 1;
  const articleScoped = !!(articleId && wantsArticleScope(retrievalQ));
  const ckey = 'a:' + KB_NAMESPACE + ':' + RETRIEVAL_VERSION + ':' + (await sha256((articleScoped ? articleId : '') + ':' + retrievalQ.trim()));
  let cached = null;
  if (cacheable && env.RL) {
    const hit = await env.RL.get(ckey);
    if (hit) { try { cached = JSON.parse(hit); } catch {} }
  }
  const useCache = !!(cached && cached.reply && Array.isArray(cached.passages));

  // 检索（缓存命中则复用其 passages/sources）
  let passages = [], sources = [], system = '';
  if (useCache) {
    passages = cached.passages; sources = cached.sources || [];
  } else {
    let matches = [];
    try {
      const filter = articleScoped ? { aid: articleId } : null;
      const queries = await buildRetrievalQueries(env, retrievalQ);   // 多查询：原问 +（可选）文言改写
      const qvs = await embed(env, queries);
      const pools = await Promise.all(qvs.map((qv) => queryKnowledgeBase(env, qv, filter)));
      matches = mergeMatchPools(pools);
    } catch { /* 检索失败则裸答 */ }
    // ① 去重：原文近似相同的（如精选读本与文钞重出）只保留一条，得到候选池
    matches = dedupeMatches(matches);
    // ② 交叉编码器重排序：把真正最相关的段排到前面，再取 TOP_K 喂给 DeepSeek
    matches = await rerankMatches(env, retrievalQ, matches);
    matches = matches.slice(0, TOP_K);
    const ctxBlocks = [], srcMap = new Map();
    matches.forEach((m, i) => {
      const md = m.metadata || {};
      const n = i + 1;
      const loc = md.pIndex != null ? `，第 ${Number(md.pIndex) + 1} 段` : '';
      ctxBlocks.push(`【${n}】《${md.title || ''}》${md.volName ? `（${md.volName}${loc}）` : ''}\n${md.text || ''}`);
      const url = md.url || (md.aid ? articlePath(md.aid, md.pIndex) : '');
      passages.push({
        n,
        aid: md.aid || '',
        title: md.title || '',
        text: md.text || '',
        url,
        pIndex: md.pIndex,
        paraIndex: md.paraIndex,
        seg: md.seg,
        part: md.part,
        vol: md.vol || '',
        volName: md.volName || '',
        sourceType: md.sourceType || '',
      });
      if (md.aid && !srcMap.has(md.aid)) srcMap.set(md.aid, { id: md.aid, title: md.title || '', url });
    });
    sources = [...srcMap.values()].slice(0, 8);
    const context = ctxBlocks.join('\n\n') || '（未检索到相关资料）';
    system = `你是「印光法师文钞」知识库助手。下面【资料】是依用户问题检索到的文钞段落，各以【n】编号。务必：
1. 只依据这些资料作答，不引入资料以外的说法、不自行发挥、不做资料未支持的推断；若资料未涵盖或问题与文钞/净土无关，直接说「文钞中未见相关开示」并可建议换个问法，绝不编造、绝不臆测。
2. 每一处论断后都用方括号标出所依据的资料编号，如 [1] 或 [2][5]，确保每个要点都可被点开核对；优先直接引用大师原文并加引号，且引文须与所标编号的资料一致，不可张冠李戴。
3. 资料之间若说法有出入，如实并列、不强行调和；不扮演佛菩萨或祖师口吻，不预言吉凶、不轻下因果定论；语气恭敬平实。
4. 简明扼要、紧扣问题，控制在约 ${ANSWER_CHARS} 字以内。

【资料】
${context}`;
  }
  const cite = sources.length ? '参见：' + sources.map((s) => `《${s.title}》`).join('、') : '回答仅供参考，请核对《文钞》原文';

  // ---- 流式输出（ndjson 逐行：meta / delta / done）----
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      send({ type: 'meta', passages, sources, cite });
      if (useCache) {
        send({ type: 'delta', text: cached.reply });
        send({ type: 'done' });
        controller.close();
        return;
      }
      let full = '';
      try {
        const ds = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
          body: JSON.stringify({
            model: CHAT_MODEL,
            messages: [{ role: 'system', content: system }, ...msgs],
            temperature: 0.3, max_tokens: MAX_TOKENS, stream: true,
          }),
        });
        if (!ds.ok || !ds.body) {
          send({ type: 'delta', text: '上游服务繁忙，请稍后重试。' });
          send({ type: 'done' }); controller.close(); return;
        }
        const reader = ds.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const d = line.slice(5).trim();
            if (d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const t = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
              if (t) { full += t; send({ type: 'delta', text: t }); }
            } catch { /* 跳过半行 */ }
          }
        }
      } catch { if (!full) send({ type: 'delta', text: '上游服务连接失败，请稍后重试。' }); }
      if (cacheable && env.RL && full) {
        await env.RL.put(ckey, JSON.stringify({ reply: full, cite, sources, passages }), { expirationTtl: CACHE_TTL });
      }
      send({ type: 'done' });
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}

/* ---------- 反馈闭环：有帮助 / 需更正 → 存 KV，供日后人工审核沉淀 ---------- */
async function handleFeedback(req, env, headers) {
  let b;
  try { b = await req.json(); } catch { b = null; }
  const vote = b && (b.vote === 'up' ? 'up' : b.vote === 'down' ? 'down' : null);
  if (!vote || !b.question) return json({ ok: false }, 400, headers);
  if (env.RL) {
    const key = 'fb:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
    await env.RL.put(key, JSON.stringify({
      q: String(b.question).slice(0, 300), vote,
      note: String(b.note || '').slice(0, 500),
      a: String(b.reply || '').slice(0, 600),
      t: new Date().toISOString(),
    }), { expirationTtl: 400 * 86400 });
  }
  return json({ ok: true }, 200, headers);
}

/* ---------- 管理后台：审阅反馈（口令 = INDEX_SECRET）---------- */
async function handleAdminData(req, env, headers) {
  const secret = req.headers.get('X-Admin-Secret') || '';
  if (!env.INDEX_SECRET || secret !== env.INDEX_SECRET) return json({ error: 'forbidden' }, 403, headers);
  if (!env.RL) return json({ stats: { up: 0, down: 0, total: 0 }, items: [], kb: null }, 200, headers);
  const list = await env.RL.list({ prefix: 'fb:', limit: 1000 });
  const keys = list.keys.map((k) => k.name).sort().slice(-150).reverse();   // 最近 150 条
  const items = []; let up = 0, down = 0;
  for (const k of keys) {
    const v = await env.RL.get(k);
    if (!v) continue;
    let o; try { o = JSON.parse(v); } catch { continue; }
    if (o.vote === 'up') up++; else if (o.vote === 'down') down++;
    items.push(o);
  }
  let kb = null;
  try { const d = await env.VEC.describe(); kb = d.vectorsCount != null ? d.vectorsCount : (d.vectorCount != null ? d.vectorCount : null); } catch { /* 可选 */ }
  return json({ stats: { up, down, total: up + down }, items, kb }, 200, headers);
}

async function handleHealth(env, headers) {
  let kb = null;
  try {
    const d = await env.VEC.describe();
    kb = d.vectorsCount != null ? d.vectorsCount : (d.vectorCount != null ? d.vectorCount : null);
  } catch { /* 可选 */ }
  return json({
    ok: true,
    service: 'wenchao-ai',
    namespace: KB_NAMESPACE,
    embedModel: EMBED_MODEL,
    chatModel: CHAT_MODEL,
    rerank: USE_RERANK ? RERANK_MODEL : false,
    rerankPool: RERANK_POOL,
    queryRewrite: USE_QUERY_REWRITE,
    retrievalVersion: RETRIEVAL_VERSION,
    topK: TOP_K,
    chunkChars: CHUNK_CHARS,
    indexBatch: INDEX_BATCH,
    vectors: kb,
  }, 200, headers);
}

const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>问文钞 · 管理后台</title>
<style>
:root{--paper:#f6f1e6;--ink:#322a1e;--ink2:#6d5f49;--ink3:#a3937a;--line:#d9cdb2;--cinnabar:#b03a26;--soft:rgba(176,58,38,.1)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.7 "Noto Serif SC",serif;padding:18px;max-width:880px;margin:0 auto}
h1{font-size:20px;margin:6px 0 2px}.sub{color:var(--ink3);font-size:13px;margin-bottom:16px}
.login{display:flex;gap:8px;margin:24px 0}input{flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;font:15px serif}
button{border:0;background:var(--cinnabar);color:#fff;padding:9px 18px;border-radius:8px;cursor:pointer;font-size:14px}
.stats{display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin:8px 0 14px;color:var(--ink2);font-size:14px}.stats b{color:var(--cinnabar)}
.filters{display:flex;gap:8px;margin-bottom:12px}.filters button{background:#fff;color:var(--ink2);border:1px solid var(--line)}.filters button.on{background:var(--cinnabar);color:#fff;border-color:var(--cinnabar)}
.item{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0;background:#fff}.item.down{border-color:var(--cinnabar);background:var(--soft)}
.vote{font-size:12px;padding:2px 9px;border-radius:999px;margin-right:8px}.vote.up{background:#e7efe0;color:#3a6b2e}.vote.down{background:var(--soft);color:var(--cinnabar)}
.q{font-weight:600;margin:5px 0}.note{color:var(--cinnabar);font-size:13.5px;margin:4px 0}.a{color:var(--ink2);font-size:13px;white-space:pre-wrap;max-height:5em;overflow:auto;border-top:1px dashed var(--line);padding-top:6px;margin-top:6px}
.t{color:var(--ink3);font-size:12px}.empty{color:var(--ink3);text-align:center;padding:48px}
</style></head><body>
<h1>问文钞 · 管理后台</h1><div class="sub">用户反馈审阅 · 为「精选问答」沉淀打底</div>
<div id="app"></div>
<script>
(function(){
var S=sessionStorage.getItem('wc_admin')||'',items=[],filter='all',kb=null,st={};
var app=document.getElementById('app');
function esc(s){return (s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function login(msg){app.innerHTML='<div class="login"><input id="pw" type="password" placeholder="管理口令"><button id="go">进入</button></div>'+(msg?'<div class="sub" style="color:var(--cinnabar)">'+msg+'</div>':'');document.getElementById('go').onclick=enter;document.getElementById('pw').onkeydown=function(e){if(e.key==='Enter')enter()}}
function enter(){S=document.getElementById('pw').value.trim();sessionStorage.setItem('wc_admin',S);load()}
function load(){app.innerHTML='<div class="empty">载入中…</div>';fetch('/admin/data',{method:'POST',headers:{'X-Admin-Secret':S}}).then(function(r){if(r.status===403)throw 'forbidden';return r.json()}).then(function(d){items=d.items||[];st=d.stats||{};kb=d.kb;render()}).catch(function(e){sessionStorage.removeItem('wc_admin');login(e==='forbidden'?'口令有误':'载入失败，请重试')})}
function render(){
var rows=items.filter(function(it){return filter==='all'||it.vote===filter});
var h='<div class="stats"><span>有帮助 <b>'+(st.up||0)+'</b></span><span>需更正 <b>'+(st.down||0)+'</b></span><span>共 <b>'+(st.total||0)+'</b> 条</span>'+(kb!=null?'<span>知识库 <b>'+kb+'</b> 段</span>':'')+'<span style="margin-left:auto"><button id="rf" style="background:#fff;color:var(--ink2);border:1px solid var(--line)">刷新</button></span></div>';
h+='<div class="filters"><button data-f="all" class="'+(filter==='all'?'on':'')+'">全部</button><button data-f="down" class="'+(filter==='down'?'on':'')+'">需更正</button><button data-f="up" class="'+(filter==='up'?'on':'')+'">有帮助</button></div>';
if(!rows.length)h+='<div class="empty">暂无反馈</div>';
rows.forEach(function(it){h+='<div class="item '+(it.vote==='down'?'down':'')+'"><span class="vote '+(it.vote||'')+'">'+(it.vote==='up'?'有帮助':'需更正')+'</span><span class="t">'+esc((it.t||'').replace('T',' ').slice(0,16))+'</span><div class="q">'+esc(it.q)+'</div>'+(it.note?'<div class="note">更正：'+esc(it.note)+'</div>':'')+(it.a?'<div class="a">'+esc(it.a)+'</div>':'')+'</div>'});
app.innerHTML=h;
document.getElementById('rf').onclick=load;
Array.prototype.forEach.call(document.querySelectorAll('.filters button'),function(b){b.onclick=function(){filter=b.getAttribute('data-f');render()}});
}
if(S)load();else login();
})();
</script></body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const apiPrefix = '/api/ai';
    const pathname = url.pathname.startsWith(apiPrefix)
      ? (url.pathname.slice(apiPrefix.length) || '/')
      : url.pathname;
    if (req.method === 'GET' && pathname === '/admin') {
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const origin = req.headers.get('Origin') || '';
    const headers = { 'Content-Type': 'application/json', ...cors(origin) };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) return handleHealth(env, headers);
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers });
    if (pathname === '/index') return handleIndex(req, env, url, headers);
    if (pathname === '/feedback') return handleFeedback(req, env, headers);
    if (pathname === '/admin/data') return handleAdminData(req, env, headers);
    return handleAsk(req, env, headers);
  },
};
