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
const REASONER_MODEL = 'deepseek-reasoner';   // 难题可路由到推理模型（更强综合，但更慢更贵）
const USE_REASONER_FOR_HARD = false;          // 难题路由总开关：默认关；置 true 后对比较/辨析类长问改用 reasoner
const USE_CONDENSE = true;                     // 多轮追问改写：把含指代/省略的追问改写成可独立检索的完整问题
const KB_NAMESPACE = 'v2';                // 优化后的知识库命名空间；默认 namespace 保留作回退
const TOP_K = 8;                          // 喂给 DeepSeek 的最终段数
const RERANK_MODEL = '@cf/baai/bge-reranker-base'; // 交叉编码器重排序，提升检索精度
const RERANK_POOL = 32;                    // 去重后送入重排序的候选段上限
const USE_RERANK = true;                   // 重排序总开关（异常时可一键回退纯向量序）
const USE_QUERY_REWRITE = true;            // 多查询：原问 + DeepSeek 文言改写检索式
const USE_HYBRID = true;                   // 混合检索：向量召回 + D1 全文(关键词)召回 → RRF 融合；缺 D1 或异常自动退回纯向量
const LEX_TOPK = 30;                       // 关键词(全文)召回上限
const RRF_K = 60;                          // RRF 融合常数(越大越平滑，弱化各路头部的绝对名次)
const RETRIEVAL_VERSION = 'r4';            // 检索/生成版本号，并入答案缓存键，避免旧缓存遮蔽新逻辑(r4: 追问改写+引用自检+接地 prompt 加范围约束)
const ANSWER_CHARS = 500;                 // 回复字数上限(软引导)
const MAX_TOKENS = 700;                   // 回复 token 硬上限(约 500 汉字)
const CACHE_TTL = 7 * 86400;              // 答案缓存 7 天
const DAILY_LIMIT = 60;                   // 每 IP 每日提问上限
const INDEX_BATCH = 25;                   // 每次 /index 处理的文章数
const INDEX_EMBED_BATCH = 50;             // 每次 Workers AI embedding 文本数
const CHUNK_CHARS = 720;                  // 单个向量块目标字数，避免长段被截断
const CHUNK_OVERLAP = 80;                 // 长段切块重叠，保留上下文
const PARENT_CHARS = 1100;               // 小块检索、大块喂入：命中后喂给模型的「父段落」字数上限（引用卡片仍用精确小块）

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
/* 中文全文检索分词：FTS5 trigram 不能匹配 2 字词、unicode61 又把整段连成一个 token，
 * 故自建「重叠二元(bigram)」分词——把汉字串切成相邻两字一组，英数词整体保留。
 * 建库时对每段文本生成 bigram 串入 D1 FTS5；提问时对关键词同法切分做短语匹配，
 * 让「戒杀」「念佛三昧」这类名相也能精确召回。 */
function cjkBigrams(s) {
  const out = [];
  const tokens = String(s || '')
    .replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/);
  for (const tk of tokens) {
    if (!tk) continue;
    if (!/\p{Script=Han}/u.test(tk)) { out.push(tk.toLowerCase()); continue; } // 英数词整体保留
    const chars = [...tk];
    if (chars.length === 1) { out.push(chars[0]); continue; }                   // 单字兜底
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}
/* 把切块文本（含原文+白话）摊平成可检索文本：去掉「（白话）」标记与换行 */
function lexText(text) {
  return String(text || '').replace(/\n（白话）/g, ' ').replace(/^（白话）/, '');
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
    // 父段落：完整一段（必要时截断），命中小块后整段喂给模型，避免长句被切块截断、利于综合
    const ctx = text.length > PARENT_CHARS ? text.slice(0, PARENT_CHARS) : text;
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
          ctx,
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

/* ---------- D1 全文索引（关键词召回）：建库时把每个切块的 bigram 串与元数据写入 FTS5 ----------
 * 与向量库并行存在；缺 D1 绑定或写失败都不影响向量建库，仅退化为「只靠向量召回」。 */
async function ensureFts(env, reset) {
  if (!env.DB) return false;
  try {
    if (reset) await env.DB.exec('DROP TABLE IF EXISTS chunks_fts');
    // unicode61 默认分词器作用在已用空格分好的 bigram 串上；其余列只存不索引(UNINDEXED)，便于直接复原成候选段
    await env.DB.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(' +
      'bigrams, cid UNINDEXED, text UNINDEXED, ctx UNINDEXED, aid UNINDEXED, title UNINDEXED, ' +
      'vol UNINDEXED, volName UNINDEXED, sourceType UNINDEXED, pIndex UNINDEXED, paraIndex UNINDEXED, ' +
      'seg UNINDEXED, part UNINDEXED, url UNINDEXED, origKey UNINDEXED)'
    );
    return true;
  } catch { return false; }
}
async function writeD1(env, chunks) {
  if (!env.DB || !chunks.length) return 0;
  let n = 0;
  const stmt = env.DB.prepare(
    'INSERT INTO chunks_fts(bigrams, cid, text, ctx, aid, title, vol, volName, sourceType, ' +
    'pIndex, paraIndex, seg, part, url, origKey) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (let i = 0; i < chunks.length; i += 50) {
    const part = chunks.slice(i, i + 50);
    try {
      await env.DB.batch(part.map((c) => {
        const m = c.meta || {};
        return stmt.bind(
          cjkBigrams(lexText(c.text)).join(' '),
          c.id, c.text, m.ctx || '', m.aid || '', m.title || '',
          m.vol || '', m.volName || '', m.sourceType || '',
          m.pIndex == null ? null : m.pIndex, m.paraIndex == null ? null : m.paraIndex,
          m.seg == null ? null : m.seg, m.part == null ? null : m.part,
          m.url || '', m.origKey || '',
        );
      }));
      n += part.length;
    } catch { /* 某批写 D1 失败：该批关键词召回退化为只靠向量，不阻塞建库 */ }
  }
  return n;
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
  // 全文索引：cursor===0 时整库重建（先 DROP 再 CREATE），故重建务必从 cursor=0 开始顺序跑到 done
  const d1ok = await ensureFts(env, cursor === 0);
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
  // 同一批切块写入 D1 全文索引（关键词召回用）
  const lex = d1ok ? await writeD1(env, chunks) : 0;
  const next = cursor + limit;
  return json({ ok: true, indexedArticles: batch.length, chunks: n, lexIndexed: lex, d1: d1ok,
    cursor: next, done: next >= ids.length, total: ids.length, limit, namespace: KB_NAMESPACE }, 200, headers);
}

/* ---------- 提问：检索 + DeepSeek ---------- */
function wantsArticleScope(q) {
  return /本篇|本文|此篇|这篇|這篇|此文|这封|這封|这段|這段|此段|上文|文中|这里|這裡|此处|此處|这一段|這一段/.test(q || '');
}
async function queryKnowledgeBase(env, qv, filter) {
  const topK = Math.min(TOP_K * 5, 40);   // 加宽召回，给去重/重排序更多候选可挑
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

/* 不靠 LLM 的关键词兜底：去掉疑问/虚词与标点，留下 2 字以上的内容片段作关键词。
 * LLM 抽词失败时仍能给全文检索喂上名相，best-effort。 */
const STOP_RE = /如何|怎[么麼样樣办辦]|为什[么麼]|為什[麼么]|什[么麼]|哪[些个個]|是否|可以|应该|應該|需要|这样|這樣|那样|那樣|时候|時候|意思|請問|请问|我们|我們|关于|關於|以及|还有|還有|或者|的话|的話|一下|呢|吗|嗎|了|啊|呀|吧|和|与|與|及|在|对|對|把|被|给|給|让|讓|向|往|从|從|по/g;
function naiveTerms(q) {
  const segs = String(q || '')
    .replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, ' ')
    .replace(STOP_RE, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= 2);
  return [...new Set(segs)].slice(0, 6);
}

/* 多查询 + 关键词抽取：一次 DeepSeek 调用同时产出
 *   - 贴近文钞文言、突出名相的「改写检索式」（供向量召回）
 *   - 2~5 个关键名相「关键词」（供 D1 全文召回）
 * 返回 { queries:[原问,(改写)], terms:[关键词…] }。best-effort：超时/解析失败都退回原问 + 启发式关键词，绝不阻塞问答。 */
async function buildRetrieval(env, q) {
  const result = { queries: [q], terms: naiveTerms(q) };
  if (!USE_QUERY_REWRITE || !env.DEEPSEEK_API_KEY) return result;
  try {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: '你是《印光法师文钞》检索助手。读用户问题后只输出一行 JSON：{"q":"改写后的检索式","kw":["名相1","名相2"]}。其中 q 是把口语/白话问题改写成更贴近文钞文言、突出关键名相的检索式（30字内）；kw 是 2~5 个最关键的名相/术语词（如「念佛三昧」「敦伦尽分」「十念记数」）。不要解释，不要代码块，只输出该 JSON。' },
          { role: 'user', content: q },
        ],
        temperature: 0, max_tokens: 120, stream: false,
      }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(4500);
    const r = await fetch('https://api.deepseek.com/chat/completions', opts);
    if (r.ok) {
      const j = await r.json();
      let raw = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
      const mt = raw.match(/\{[\s\S]*\}/);            // 容错：剥掉可能的代码块/前后缀，取第一段 JSON
      if (mt) {
        try {
          const o = JSON.parse(mt[0]);
          const rw = String(o.q || '').replace(/^["“”\s]+|["“”\s]+$/g, '').trim();
          if (rw && rw !== q && rw.length <= 60) result.queries.push(rw);
          if (Array.isArray(o.kw)) {
            const kws = o.kw.map((s) => String(s || '').trim()).filter((s) => [...s].length >= 2);
            if (kws.length) result.terms = [...new Set(kws)].slice(0, 6);
          }
        } catch { /* JSON 解析失败：保留启发式关键词 */ }
      }
    }
  } catch { /* 改写失败：仅用原问 + 启发式关键词 */ }
  return result;
}

/* D1 全文(关键词)召回：把关键词逐个切成 bigram 短语，OR 组合后做 FTS5 MATCH，
 * 取回与向量候选同构的 match（含 metadata），供 RRF 融合。best-effort：缺 D1/无词/异常都返回 []。 */
async function lexicalSearch(env, terms, filter) {
  if (!USE_HYBRID || !env.DB || !terms || !terms.length) return [];
  const exprs = [];
  for (const t of terms) {
    const bg = cjkBigrams(t);
    if (bg.length) exprs.push('"' + bg.join(' ') + '"');   // bigram 已剔除引号等特殊字符，可安全包裹为短语
  }
  if (!exprs.length) return [];
  let match = exprs.map((e) => '(' + e + ')').join(' OR ');
  const cols = 'cid,text,ctx,aid,title,vol,volName,sourceType,pIndex,paraIndex,seg,part,url,origKey';
  try {
    let sql = `SELECT ${cols} FROM chunks_fts WHERE chunks_fts MATCH ?`;
    const binds = [match];
    if (filter && filter.aid) { sql += ' AND aid = ?'; binds.push(filter.aid); }
    sql += ' ORDER BY rank LIMIT ?';
    binds.push(LEX_TOPK);
    const rs = await env.DB.prepare(sql).bind(...binds).all();
    const rows = (rs && rs.results) || [];
    return rows.map((row) => ({
      id: row.cid,
      metadata: {
        text: row.text || '', ctx: row.ctx || '', aid: row.aid || '', title: row.title || '',
        vol: row.vol || '', volName: row.volName || '', sourceType: row.sourceType || '',
        pIndex: row.pIndex, paraIndex: row.paraIndex, seg: row.seg, part: row.part,
        url: row.url || '', origKey: row.origKey || '',
      },
    }));
  } catch { return []; }   // FTS 语法/连接异常：退回纯向量
}

/* RRF（倒数排名融合）：把多路召回按各自名次融合成一个排序，弱化「分数尺度不可比」问题。
 * score = Σ 1/(RRF_K + 该路名次)。同 id 取信息更全的 metadata。 */
function fuseRRF(pools) {
  const acc = new Map();
  for (const pool of pools) {
    (pool || []).forEach((m, i) => {
      const prev = acc.get(m.id);
      const s = 1 / (RRF_K + i + 1);
      if (!prev) acc.set(m.id, { m, s });
      else {
        prev.s += s;
        if ((!prev.m.metadata || !prev.m.metadata.text) && m.metadata && m.metadata.text) prev.m = m;
      }
    });
  }
  return [...acc.values()].map((e) => ({ ...e.m, score: e.s })).sort((a, b) => b.score - a.score);
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

/* 多轮追问改写（condense question）：把末句可能含指代/省略的追问，结合最近对话改写成
 * 可独立检索的完整问题。best-effort：未开/无历史/失败都退回原启发式（短问或承上时并入上一问）。 */
const FOLLOWUP_RE = /它|他|她|这|那|上(面|述|文)|继续|再|还有|为什[么麽]|怎[么样]|出处|展开|具体|详细|例子|呢[？?]?$/;
async function condenseQuestion(env, msgs, lastU) {
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const prevU = userMsgs.length > 1 ? userMsgs[userMsgs.length - 2].content : '';
  const heuristic = (prevU && (lastU.length < 12 || FOLLOWUP_RE.test(lastU))) ? prevU + '。' + lastU : lastU;
  if (!USE_CONDENSE || !env.DEEPSEEK_API_KEY || !prevU) return heuristic;
  try {
    const hist = msgs.slice(-5)
      .map((m) => (m.role === 'user' ? '用户：' : '助手：') + String(m.content).slice(0, 200)).join('\n');
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: '你是检索助手。根据对话历史，把用户最后一句可能含指代/省略的追问，改写成一句可独立用于检索的完整问题（补全主语与话题、保留原意）；若末句本身已完整，原样输出。只输出这句问题，不解释、不加引号，40字以内。' },
          { role: 'user', content: hist },
        ],
        temperature: 0, max_tokens: 80, stream: false,
      }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(4500);
    const r = await fetch('https://api.deepseek.com/chat/completions', opts);
    if (r.ok) {
      const j = await r.json();
      const rw = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')
        .replace(/^["“”\s]+|["“”\s]+$/g, '').trim();
      if (rw && rw.length >= 4 && rw.length <= 80) return rw;
    }
  } catch { /* 改写失败：退回启发式 */ }
  return heuristic;
}

/* 难题判别：比较/辨析类、含多问、较长的问题，综合难度高，可（在开关打开时）路由到 reasoner */
function isHardQuestion(q) {
  const s = String(q || '');
  const multiQ = (s.match(/[？?]/g) || []).length >= 2;
  return s.length >= 24 || multiQ ||
    /区别|不同|对比|對比|比较|比較|异同|異同|关系|關係|为何|為何|界限|混滥|混濫|双修|雙修|与.{0,8}[的之]?(区别|不同|关系)/.test(s);
}

/* 引用逐字自检：纯字符串校验回答里的 [n]——编号是否在资料范围内、「直引原文」是否能在所标资料中逐字找到。
 * 不改写已流式输出的内容，仅作遥测/评测信号（接地忠实度），契合「不妄语·可核验优先」。 */
function normForMatch(s) {
  return String(s || '').replace(/[\s，。、；：！？「」『』“”"'‘’（）()【】\[\]．·—\-…\n]/g, '');
}
function validateCitations(reply, passages, ctxTexts) {
  const text = String(reply || '');
  const N = passages.length;
  const nums = [...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => +m[1]);
  const invalid = nums.filter((n) => n < 1 || n > N).length;
  let quoteChecked = 0, quoteOk = 0;
  const qre = /[「“"]([^」”"\n]{2,40})[」”"]\s*\[(\d{1,2})\]/g;
  let mm;
  while ((mm = qre.exec(text))) {
    quoteChecked++;
    const n = +mm[2];
    if (n < 1 || n > N) continue;
    const src = (ctxTexts && ctxTexts[n - 1]) || (passages[n - 1] && passages[n - 1].text) || '';
    if (normForMatch(src).includes(normForMatch(mm[1]))) quoteOk++;
  }
  const faithful = invalid === 0 && (quoteChecked === 0 || quoteOk === quoteChecked);
  return { cited: nums.length, invalid, quoteChecked, quoteOk, faithful };
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
  // ② 多轮追问改写：把含指代/省略的追问改写成可独立检索的完整问题（LLM best-effort，失败退回启发式拼接）
  const retrievalQ = await condenseQuestion(env, msgs, lastU);

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
  let ctxTexts = [];   // 喂给模型的父段落正文（按 passage 序），用于引用逐字自检
  if (useCache) {
    passages = cached.passages; sources = cached.sources || [];
  } else {
    let matches = [];
    try {
      const filter = articleScoped ? { aid: articleId } : null;
      const { queries, terms } = await buildRetrieval(env, retrievalQ);  // 多查询(原问+文言改写) + 关键词
      const [qvs, lex] = await Promise.all([
        embed(env, queries),
        lexicalSearch(env, terms, filter),                              // D1 全文(关键词)召回，与向量化并行
      ]);
      const pools = await Promise.all(qvs.map((qv) => queryKnowledgeBase(env, qv, filter)));
      const vecMerged = mergeMatchPools(pools);                          // 多路向量并集(各保留最高分)
      // 向量 + 关键词两路 RRF 融合；未开混合或关键词无命中时退回纯向量序
      matches = (USE_HYBRID && lex.length) ? fuseRRF([vecMerged, lex]) : vecMerged;
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
      // 小块检索、大块喂入：喂给模型的是命中小块所在的「父段落」(md.ctx)，更完整、利于综合；引用卡片仍用精确小块 md.text
      const ctxText = md.ctx || md.text || '';
      ctxBlocks.push(`【${n}】《${md.title || ''}》${md.volName ? `（${md.volName}${loc}）` : ''}\n${ctxText}`);
      ctxTexts.push(ctxText);   // 留作引用逐字自检：以「模型真正看到的父段落」为准
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
    system = `你是「印光法师文钞」知识库助手，仿 NotebookLM 的「源接地」方式作答：下面【资料】是依用户问题从文钞中检索到的段落，各以【n】编号；你只是这些资料的转述与归纳者，把「可核验」放在第一位。务必：

1. 严格接地：只依据【资料】中的内容回答，绝不掺入资料之外的常识、教理或自己的发挥，凡资料未支持的一律不说。问题若超出资料范围，或与文钞、净土无关，直接答「文钞中未见相关开示」，可建议换个问法，绝不臆测编造。
2. 逐点引用：每一处论断之后都用方括号标出所依据的资料编号，如 [1] 或 [2][5]，做到句句可点开核对原文；优先直接引用大师原文并加引号，引文须与所标编号的资料严格一致、能逐字对上，不可张冠李戴。【资料】共 ${passages.length} 条，编号 1–${passages.length}，**不得引用此范围外的编号**。
3. 综合而非罗列：把多段资料融会成连贯回答，不要逐段复述；资料之间说法有出入时如实并列，不强行调和。
4. 条理清晰：当内容涉及多个方面时，用简短小标题（如「一、…」）配合分点（1. 2. …）、必要时子项来组织，便于阅读；问题简单则直接作答，不强行套格式。
5. 恭敬平实：不扮演佛菩萨或祖师口吻、不预言吉凶、不轻下因果定论；直接作答，不写「根据资料」「综上所述」之类的套话。
6. 紧扣问题、简明，控制在约 ${ANSWER_CHARS} 字以内。

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
        send({ type: 'done', verify: validateCitations(cached.reply, passages, ctxTexts) });
        controller.close();
        return;
      }
      // 难题路由：开关打开且属比较/辨析类长问时，改用 reasoner（推理 token 不在 delta.content 里，自然不外显）
      const model = (USE_REASONER_FOR_HARD && isHardQuestion(retrievalQ)) ? REASONER_MODEL : CHAT_MODEL;
      let full = '';
      try {
        const ds = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
          body: JSON.stringify({
            model,
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
      // 引用逐字自检：以模型实际看到的父段落为准，校验 [n] 是否越界、直引是否能逐字对上（遥测信号，不改写已输出内容）
      send({ type: 'done', verify: full ? validateCitations(full, passages, ctxTexts) : null });
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
  // D1 全文索引自检：绑定是否存在、已建多少行（缺 D1 时为 null，混合检索自动退回纯向量）
  let lexRows = null, hybridReady = false;
  if (env.DB) {
    try {
      const r = await env.DB.prepare('SELECT count(*) AS c FROM chunks_fts').first();
      lexRows = r && r.c != null ? r.c : null;
      hybridReady = USE_HYBRID && lexRows > 0;
    } catch { /* 表未建或查询失败 */ }
  }
  return json({
    ok: true,
    service: 'wenchao-ai',
    namespace: KB_NAMESPACE,
    embedModel: EMBED_MODEL,
    chatModel: CHAT_MODEL,
    rerank: USE_RERANK ? RERANK_MODEL : false,
    rerankPool: RERANK_POOL,
    queryRewrite: USE_QUERY_REWRITE,
    condense: USE_CONDENSE,
    reasonerForHard: USE_REASONER_FOR_HARD,
    hybrid: USE_HYBRID,
    hybridReady,
    lexTopK: LEX_TOPK,
    rrfK: RRF_K,
    lexRows,
    parentChars: PARENT_CHARS,
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
