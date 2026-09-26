/* 印光法师文钞 · 知识库问答（基于全文钞的 NotebookLM）
 *
 * 架构（全在 Cloudflare）：
 *   建库(一次)：/index 批量抓全站文章 → 切段 → SiliconFlow(bge-m3) 向量 → 存入 Vectorize
 *   提问：问题 →(可选)文言改写多查询 → 向量 → Vectorize 召回 → 交叉编码器重排序 → SiliconFlow(DeepSeek-V4-Flash) 据最相关段作答(标出处·限字数)
 *   缓存：① 向量库本身(建一次长期用) ② 答案缓存(同问秒回,KV) ③ SiliconFlow 前缀自动缓存
 *
 * 前端契约：POST { messages:[{role,content}…], articleId? } → { reply, cite, sources:[{id,title}] }
 *
 * 绑定(见 wrangler.toml)：VEC(Vectorize)、RL(KV 限流+答案缓存)、DB(D1 全文索引)
 * 密钥(Secret)：SILICONFLOW_API_KEY(问答+嵌入+重排序+TTS，统一硅基流动)、INDEX_SECRET(保护 /index)
 *
 * 建库：部署后调用（分批，循环到 done:true）
 *   curl -X POST "https://<worker>/index?cursor=0" -H "X-Index-Secret: <INDEX_SECRET>"
 */

const ALLOW_ORIGINS = [
  'https://wenchao.foyue.org',
  'https://www.wenchao.foyue.org',
  'https://wenchao.pages.dev',
  // 安卓离线 APP（1.1.0 起）。它的页面由 WebViewAssetLoader 挂在这个本地虚拟域下，
  // 不走网络；但对 Worker 而言，它发来的请求就成了跨域，故必须列进来——
  // 漏了这条的表现是：APP 里问答与朗读全部接不上（预检拿到的 allow-origin 是
  // 列表首项，与请求 origin 对不上，被 WebView 拦下），2026-08-29 实测确认。
  //
  // 关于安全：这个域名是 androidx 的固定值，任何安卓应用都能用，不构成身份凭据。
  // 但 isFirstParty 本就是 Origin/Referer 级别的弱防护（两者都可伪造），
  // 真正的额度控制在 authenticate 与 KV 限流那一层，故加入它不改变安全模型。
  'https://appassets.androidplatform.net',
  'http://localhost:4188',
  'http://127.0.0.1:4188',
];
const SITE_BASE = 'https://wenchao.foyue.org';
const SF_BASE = 'https://api.siliconflow.cn/v1';   // 硅基流动：统一入口（嵌入 + 重排序 + 问答生成 + TTS）
const DEEPSEEK_BASE = 'https://api.deepseek.com';  // 生成备用通道；仍只依据检索到的文钞原文
const EMBED_MODEL = 'BAAI/bge-m3';       // 多语种向量(含古今汉语)，1024 维（硅基流动；与原 Cloudflare bge-m3 同模型，向量兼容，无需重建库）
const CHAT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';  // 非思考模式（硅基流动；原 deepseek-v4-flash，迁移至硅基统一管理）
const REASONER_MODEL = 'deepseek-ai/DeepSeek-V4-Pro'; // 难题路由用更强模型 + 思考模式（USE_REASONER_FOR_HARD 默认关；硅基流动）
const USE_REASONER_FOR_HARD = false;          // 难题路由总开关：默认关；置 true 后对比较/辨析类长问改用 pro + 思考模式
const USE_CONDENSE = true;                     // 多轮追问改写：把含指代/省略的追问改写成可独立检索的完整问题
const KB_NAMESPACE = 'v2';                // 优化后的知识库命名空间；默认 namespace 保留作回退
const TOP_K = 8;                          // 喂给 DeepSeek 的最终段数
const RERANK_MODEL = 'BAAI/bge-reranker-v2-m3'; // 交叉编码器重排序，提升检索精度（硅基流动）
const RERANK_POOL = 16;                    // 去重后送入重排序的候选段上限（越小越省 Workers AI 神经元；免费版日额有限）
const USE_RERANK = true;                   // 重排序总开关（异常时可一键回退纯向量序）
const USE_QUERY_REWRITE = true;            // 多查询：原问 + DeepSeek 文言改写检索式
const USE_HYBRID = true;                   // 混合检索：向量召回 + D1 全文(关键词)召回 → RRF 融合；缺 D1 或异常自动退回纯向量
const LEX_TOPK = 30;                       // 关键词(全文)召回上限
const RRF_K = 60;                          // RRF 融合常数(越大越平滑，弱化各路头部的绝对名次)
const RETRIEVAL_VERSION = 'r12';           // r12: 引用校验后才缓存；淘汰缺少核验证据的旧回答
const ANSWER_CACHE_VERSION = 1;
const ANSWER_CHARS = 500;                 // 回复字数上限(软引导)
const MAX_TOKENS = 700;                   // 回复 token 硬上限(约 500 汉字)
const CACHE_TTL = 7 * 86400;              // 答案缓存 7 天
const SF_BILLING_BREAKER = 'upstream:sf:402';
const SF_BILLING_BREAKER_TTL = 300;        // 付款故障期间 5 分钟内跳过硅基流动，避免每问都等上游超时
const DAILY_LIMIT = 60;                   // 每 IP 每日提问上限（自家网页/匿名路径）
const REQUIRE_KEY_FOR_API = true;         // 非自家网页(无白名单 Origin/Referer)的请求必须带有效 API key；置 false 则匿名 curl 也可用(仅受每 IP 日限额)
const KEY_DAILY_LIMIT = 2000;             // API key 默认每日额度；可在 API_KEYS 里给某个 key 加 "limit" 字段单独覆盖
const INDEX_BATCH = 25;                   // 每次 /index 处理的文章数
const INDEX_EMBED_BATCH = 50;             // 每次 Workers AI embedding 文本数
const CHUNK_CHARS = 720;                  // 单个向量块目标字数，避免长段被截断
const CHUNK_OVERLAP = 80;                 // 长段切块重叠，保留上下文
const PARENT_CHARS = 1100;               // 小块检索、大块喂入：命中后喂给模型的「父段落」字数上限（引用卡片仍用精确小块）
const SEARCH_LIMIT = 80;                  // 网站全文搜索：去重后返回的文章数上限

/* ---------- 朗读 TTS（硅基流动 CosyVoice2 + R2 懒缓存）----------
   按需生成、懒缓存：用户点谁才生成谁，命中 R2 直接返回、不再计费。 */
const TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';   // 中文最自然，支持中/英/日/韩+方言
const TTS_FORMAT = 'mp3';                           // 体积小、浏览器兼容好
const TTS_VOICES = ['david', 'benjamin', 'charles', 'anna', 'bella', 'claire'];  // 预置音色白名单（防注入）
const TTS_DEFAULT_VOICE = 'charles';                // 默认清亮男声
const TTS_GEN_DAILY = 300;                          // 每 IP 每日「生成」上限；只计 cache-miss，命中/播放不受限
const TTS_MAX_CHARS = 2000;                         // 单次合成文本上限（段级足够；超长截断保护）
const TTS_VER = 't1';                               // 版本号并入缓存键：换模型/换读音词典时整体失效

/* ---------- 外语翻译（DharmaMitra + R2 懒缓存）----------
   上游是伯克利/维也纳的佛典翻译公益项目，模型专为汉/藏/巴利/梵佛典训练，
   接口公开免密钥（2026-08-30 实测：7.5 秒返回，信愿念佛、求生西方均译准）。

   为什么中转而不让前端直连（人家 CORS 是 * ，本可直连）：那等于把我们全部读者的
   流量直接砸到一个免费公益服务上，且每人读同一篇都要人家重算一遍。中转后一篇译过
   人人受益，限流也压在我们这边——不让公益项目替我们扛流量。 */
const TR_ENDPOINT = 'https://dharmamitra.org/api-search/cat-translate/v1/translate';
const TR_VER = 'r1';            // 并入缓存键：换上游或改术语约定时整体失效
const TR_GEN_DAILY = 400;       // 每 IP 每日「生成」上限；只计 cache-miss，命中不受限
const TR_MAX_CHARS = 3000;      // 单段上限（段级足够；超长截断保护）
const TR_TIMEOUT_MS = 75000;    // 上游自述长文最多 ~60s，留出余量

// 目标语言白名单：值是给上游的自由文本标签。不在表内一律回落英文，
// 既防注入，也避免小语种佛教术语无参照译法可依而译歪。
const TR_LANGS = {
  en: 'english', ja: 'japanese', ko: 'korean', vi: 'vietnamese',
  de: 'german', fr: 'french', es: 'spanish', ru: 'russian',
};

/* 术语约定。实测表明上游本身就译得准，这段不是用来救错的，
   是用来「统一」的——同一术语跨篇跨段必须是同一个词，读者才不会以为在讲两回事。 */
const TR_STYLE = [
  'This is Pure Land Buddhist writing by Master Yinguang (印光大师, 1861-1940),',
  'Thirteenth Patriarch of the Chinese Pure Land school. Most pieces are letters of instruction to lay disciples.',
  '',
  'Use these renderings consistently:',
  '念佛 = mindfulness of the Buddha (or reciting the Buddha\'s name)',
  '信願行 = faith, vows, and practice',
  '往生 = rebirth in the Pure Land — never "death" or "passing away"',
  '帶業往生 = rebirth carrying one\'s remaining karma',
  '西方 / 極樂世界 = the Western Pure Land / Land of Ultimate Bliss',
  '了生死 = liberation from birth-and-death',
  '阿彌陀佛 = Amitābha Buddha; 觀世音 = Avalokiteśvara',
  '敦倫盡分 = fulfilling one\'s duties in human relationships',
  '因果 = cause and effect; 業障 = karmic obstructions; 迴向 = dedication of merit',
  '',
  'Keep the plain, direct tone of a letter. Do not add commentary or explanation absent from the source.',
  'Do not omit or summarise. Translate what is there.',
].join('\n');

/* 佛门读音归一：通用 TTS 按现代普通话注音，会读错佛经专名与多音字。
   仅替换「喂给 TTS 的文本」为正确读音的同音字，屏显原文分毫不动（遵「经典原文不可篡改」）。
   保守起见只放高置信、高频易错词；拿不准的读音宁可不加，靠 /tts/report 反馈核实后再补。
   长词在前，避免短词先替换破坏长词。 */
const READ_DICT = [
  ['南无', '那摩'],   // nā mó（非 nán wú）——净土文本最高频
  ['般若', '波惹'],   // bō rě
  ['迦叶', '迦摄'],   // jiā shè（叶读 shè）
  ['伽蓝', '茄蓝'],   // qié lán
  ['刹那', '岔那'],   // chà nà
];
function normalizeReading(text) {
  let s = text;
  for (const [a, b] of READ_DICT) if (s.indexOf(a) >= 0) s = s.split(a).join(b);
  return s;
}

function cors(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
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
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SILICONFLOW_API_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, encoding_format: 'float' }),
  };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(20000);
  const r = await fetch(`${SF_BASE}/embeddings`, opts);
  if (!r.ok) {
    console.warn('wenchao embeddings HTTP', r.status, r.headers.get('x-siliconcloud-trace-id') || '');
    throw new Error('embed_http_' + r.status);
  }
  const j = await r.json();
  // 按 index 还原输入顺序，返回 [[...1024], …]
  const data = Array.isArray(j.data) ? j.data.slice().sort((a, b) => a.index - b.index) : [];
  if (data.length !== texts.length || data.some((d, i) =>
    d.index !== i || !Array.isArray(d.embedding) || d.embedding.length !== 1024)) {
    throw new Error('embed_invalid_response');
  }
  return data.map((d) => d.embedding);
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

/* 阅读搜索独立保存原文、白话、篇名，避免从 RAG 的混合切块猜测文本层。
 * 原索引照常服务问答；/index?lexOnly=1 可免费重建这两套词法索引。 */
async function ensureSearchFts(env, reset) {
  if (!env.DB) return false;
  try {
    await env.DB.exec('CREATE TABLE IF NOT EXISTS search_state (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (reset) {
      await env.DB.prepare("INSERT OR REPLACE INTO search_state(id,value) VALUES ('status','building')").run();
      await env.DB.exec('DROP TABLE IF EXISTS search_fts');
    }
    await env.DB.exec('CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(' +
      'bigrams, aid UNINDEXED, title UNINDEXED, volName UNINDEXED, layer UNINDEXED, text UNINDEXED)');
    return true;
  } catch { return false; }
}
function searchChunksOf(art) {
  const rows = [];
  const push = (layer, text) => splitLongText(text).forEach((part) => rows.push({
    aid: art.id, title: art.title || '', volName: art.volumeName || art.volume || '', layer, text: part,
  }));
  push('title', art.title || '');
  for (const seg of art.segments || []) {
    for (const text of seg.orig || (seg.o ? [seg.o] : [])) push('orig', text);
    for (const text of seg.trans || []) push('trans', text);
  }
  return rows;
}
async function writeSearchD1(env, rows) {
  const stmt = env.DB.prepare('INSERT INTO search_fts(bigrams,aid,title,volName,layer,text) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map((r) => stmt.bind(
      cjkBigrams(r.text).join(' '), r.aid, r.title, r.volName, r.layer, r.text)));
  }
  return rows.length;
}

async function handleIndex(req, env, url, headers) {
  const indexSecret = req.headers.get('X-Index-Secret') ||
    (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.INDEX_SECRET || indexSecret !== env.INDEX_SECRET) {
    return json({ error: 'forbidden' }, 403, headers);
  }
  const cursor = Number(url.searchParams.get('cursor') || '0');
  if (!Number.isInteger(cursor) || cursor < 0) return json({ error: 'invalid cursor' }, 400, headers);
  const reqLimit = parseInt(url.searchParams.get('limit') || String(INDEX_BATCH), 10);
  const limit = Math.max(1, Math.min(INDEX_BATCH, Number.isFinite(reqLimit) ? reqLimit : INDEX_BATCH));
  const catalog = await fetch(`${SITE_BASE}/data/books.json`, { cache: 'no-store' });
  if (!catalog.ok) return json({ error: 'catalog unavailable' }, 503, headers);
  const books = await catalog.json();
  const ids = [];
  for (const b of books)
    for (const j of b.juans)
      for (const c of j.cats)
        for (const it of c.items) ids.push(it.id);
  if (!ids.length || new Set(ids).size !== ids.length || cursor >= ids.length) {
    return json({ error: 'invalid catalog or cursor' }, 400, headers);
  }
  const catalogKey = await sha256(JSON.stringify(ids));

  // 只建 D1 词法索引、不重嵌入：向量库已就绪时用它补建全文索引，零嵌入调用（省额度，不动 Vectorize）
  const lexOnly = url.searchParams.get('lexOnly') === '1' || url.searchParams.get('mode') === 'lex';
  const batch = ids.slice(cursor, cursor + limit);
  // 全文索引：cursor===0 时整库重建（先 DROP 再 CREATE），故重建务必从 cursor=0 开始顺序跑到 done
  const searchOk = await ensureSearchFts(env, cursor === 0);
  if (!searchOk) return json({ ok: false, error: 'search index unavailable' }, 503, headers);
  if (cursor === 0) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO search_state(id,value) VALUES ('cursor','0')"),
      env.DB.prepare("INSERT OR REPLACE INTO search_state(id,value) VALUES ('catalog',?)").bind(catalogKey),
    ]);
  } else {
    const state = await env.DB.prepare('SELECT id,value FROM search_state').all();
    const values = Object.fromEntries(state.results.map(r => [r.id, r.value]));
    if (values.status !== 'building' || Number(values.cursor) !== cursor || values.catalog !== catalogKey) {
      return json({ ok: false, error: 'index sequence mismatch; restart at cursor=0' }, 409, headers);
    }
  }
  const d1ok = await ensureFts(env, cursor === 0);
  let chunks = [], searchRows = [], searchFailed = !searchOk;
  for (const id of batch) {
    try {
      const response = await fetch(`${SITE_BASE}/data/articles/${id}.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error('article unavailable');
      const a = await response.json();
      if (a.id !== id || !Array.isArray(a.segments) || !a.segments.length) throw new Error('invalid article');
      chunks = chunks.concat(chunksOf(a));
      searchRows = searchRows.concat(searchChunksOf(a));
    } catch { searchFailed = true; /* 完整搜索索引不能把漏篇当作建成 */ }
  }
  if (searchFailed || !d1ok) {
    await env.DB.prepare("UPDATE search_state SET value='failed' WHERE id='status'").run();
    return json({ ok: false, error: 'incomplete source batch; restart at cursor=0' }, 503, headers);
  }
  // 分小批向量化并写入(bge-m3 单次建议 ≤ ~100 条)；lexOnly 时跳过，只建下方 D1 词法索引
  let n = 0;
  if (!lexOnly) {
    for (let i = 0; i < chunks.length; i += INDEX_EMBED_BATCH) {
      const part = chunks.slice(i, i + INDEX_EMBED_BATCH);
      const vecs = await embed(env, part.map((c) => c.text));
      await env.VEC.upsert(part.map((c, k) => ({
        id: c.id, namespace: KB_NAMESPACE, values: vecs[k], metadata: { ...c.meta, text: c.text },
      })));
      n += part.length;
    }
  }
  // 同一批切块写入 D1 全文索引（关键词召回用）
  const lex = d1ok ? await writeD1(env, chunks) : 0;
  const next = Math.min(cursor + limit, ids.length);
  let searchIndexed = 0;
  if (searchOk) {
    try { searchIndexed = await writeSearchD1(env, searchRows); } catch { searchFailed = true; }
    if (lex !== chunks.length) searchFailed = true;
    if (searchFailed) await env.DB.prepare(
      "INSERT OR REPLACE INTO search_state(id,value) VALUES ('status','failed')").run();
    else await env.DB.batch([
      env.DB.prepare("UPDATE search_state SET value=? WHERE id='cursor'").bind(String(next)),
      env.DB.prepare("UPDATE search_state SET value=? WHERE id='status'").bind(next >= ids.length ? 'ready' : 'building'),
    ]);
  }
  return json({ ok: !searchFailed, indexedArticles: batch.length, chunks: n, lexIndexed: lex, d1: d1ok,
    searchIndexed, searchIndexOk: !searchFailed, searchReady: !searchFailed && next >= ids.length,
    cursor: next, done: !searchFailed && next >= ids.length, total: ids.length, limit, namespace: KB_NAMESPACE }, searchFailed ? 503 : 200, headers);
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
  let answered = false, lastError = null;
  for (const opts of attempts) {
    try {
      const res = await env.VEC.query(qv, opts);
      if (!res || !Array.isArray(res.matches)) throw new Error('vector_invalid_response');
      answered = true;
      if (res.matches.length) return res.matches;
    } catch (e) { lastError = e; /* 尝试下一种查询策略 */ }
  }
  if (!answered) throw lastError || new Error('vector_unavailable');
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
const STOP_RE = /印光(?:法师|法師|大师|大師)|印祖|文钞|文鈔|法师|法師|大师|大師|看待|认为|認為|开示|開示|如何|怎[么麼样樣办辦]|为什[么麼]|為什[麼么]|什[么麼]|哪[些个個]|是否|可以|应该|應該|需要|这样|這樣|那样|那樣|时候|時候|意思|請問|请问|我们|我們|关于|關於|以及|还有|還有|或者|的话|的話|一下|呢|吗|嗎|了|啊|呀|吧|和|与|與|及|在|对|對|把|被|给|給|让|讓|向|往|从|從|по/g;
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
  if (!USE_QUERY_REWRITE || !env.SILICONFLOW_API_KEY) return result;
  try {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SILICONFLOW_API_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: '你是《印光法师文钞》检索助手。读用户问题后只输出一行 JSON：{"q":"改写后的检索式","kw":["名相1","名相2"]}。其中 q 是把口语/白话问题改写成更贴近文钞文言、突出关键名相的检索式（30字内）；kw 是 2~5 个最关键的名相/术语词（如「念佛三昧」「敦伦尽分」「十念记数」）。不要解释，不要代码块，只输出该 JSON。' },
          { role: 'user', content: q },
        ],
        temperature: 0, max_tokens: 120, stream: false, thinking: { type: 'disabled' },
      }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(4500);
    const r = await fetch(`${SF_BASE}/chat/completions`, opts);
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
    return rows.filter((row) => row.text && row.aid && row.title).map((row) => ({
      id: row.cid,
      metadata: {
        text: row.text || '', ctx: row.ctx || '', aid: row.aid || '', title: row.title || '',
        vol: row.vol || '', volName: row.volName || '', sourceType: row.sourceType || '',
        pIndex: row.pIndex, paraIndex: row.paraIndex, seg: row.seg, part: row.part,
        url: row.url || '', origKey: row.origKey || '',
      },
    }));
  } catch { throw new Error('lexical_search_failed'); }   // 由调用方独立结算，向量召回仍可继续
}

/* 截取关键词前后一小段窗口，供前端高亮渲染（返回纯文本，HTML 转义交给前端）。
 * 找不到精确子串（如单字查询落在 bigram 边界）时，退化为该切块开头一小段，仍能给用户看到候选篇目。 */
function snippetAround(full, q) {
  const idx = full.indexOf(q);
  if (idx === -1) return full.slice(0, 56).trim();
  const from = Math.max(0, idx - 22);
  const to = Math.min(full.length, idx + q.length + 34);
  return (from > 0 ? '…' : '') + full.slice(from, to).trim() + (to < full.length ? '…' : '');
}

/* ---------- 阅读搜索：独立分层索引 + 旧版全文索引兼容 ----------
 * q 是前端 OpenCC 统一后的简体字；原文仍按库中文字返回。
 * 先按篇号去重计数，再分页取篇目，不能把切块数或本页条数冒充全库总数。 */
async function handleSearch(req, env, headers) {
  const auth = await authenticate(req, env);
  if (auth.error) return json({ error: auth.message }, auth.status, headers);
  let b; try { b = await req.json(); } catch { b = null; }
  const q = String((b && b.q) || '').trim().slice(0, 40);
  const scope = b?.scope || 'all';
  if (!['all', 'title', 'orig', 'trans'].includes(scope)) {
    return json({ error: '搜索范围不合法。' }, 400, headers);
  }
  const requestedLimit = Number(b?.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, SEARCH_LIMIT) : SEARCH_LIMIT;
  const offset = Number.isInteger(b?.offset) && b.offset >= 0 ? Math.min(b.offset, 10000) : 0;
  const empty = { hits: [], total: 0, totalExact: true, hasMore: false, scope, limit, offset, nextOffset: null };
  if (!q) return json({ ...empty, ready: true }, 200, headers);
  if (!env.DB) return json({ ...empty, ready: false, reason: 'index_unavailable' }, 200, headers);
  let layered = false;
  try {
    const status = await env.DB.prepare("SELECT value FROM search_state WHERE id = 'status'").first();
    layered = status?.value === 'ready';
  } catch { /* 老部署没有分层索引，全文仍可继续检索。 */ }
  if (!layered && scope !== 'all') {
    return json({ ...empty, ready: false, reason: 'scoped_index_pending' }, 200, headers);
  }
  const table = layered ? 'search_fts' : 'chunks_fts';
  const cols = layered ? 'aid,title,volName,text,layer' : 'aid,title,vol,volName,text,ctx';
  const scopeWhere = layered && scope !== 'all' ? ' AND layer = ?' : '';
  const scopeBinds = scopeWhere ? [scope] : [];
  try {
    const bg = cjkBigrams(q);
    const literal = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';
    let where = `text LIKE ? ESCAPE '\\'${scopeWhere}`;
    let binds = [literal, ...scopeBinds];
    let total = 0;
    // 单字不在相邻二元词 token 中，直接 LIKE；其余查询先用 FTS 缩小范围。
    if (/^\p{Script=Han}{2,}$/u.test(q) && bg.length) {
      where = `${table} MATCH ? AND ${where}`;
      binds.unshift('"' + bg.join(' ') + '"');
      const count = await env.DB.prepare(
        `SELECT COUNT(DISTINCT aid) AS total FROM ${table} WHERE ${where}`
      ).bind(...binds).first();
      total = Number(count?.total || 0);
    }
    if (!total) {
      where = `text LIKE ? ESCAPE '\\'${scopeWhere}`;
      binds = [literal, ...scopeBinds];
      const count = await env.DB.prepare(
        `SELECT COUNT(DISTINCT aid) AS total FROM ${table} WHERE ${where}`
      ).bind(...binds).first();
      total = Number(count?.total || 0);
    }
    // 搜索结果一篇一条，先去重再截页；同篇任取一个确实命中的文本段作为摘要。
    const rs = total ? await env.DB.prepare(
      `SELECT ${cols} FROM ${table} WHERE ${where} GROUP BY aid ORDER BY aid LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all() : { results: [] };
    const hits = (rs?.results || []).map((row) => ({
      i: row.aid, t: row.title || '', v: row.volName || row.vol || '',
      snip: snippetAround(layered ? String(row.text || '') : lexText(row.text || row.ctx || ''), q),
      ...(layered ? { layer: row.layer } : {}),
    }));
    let ready = true;
    if (!layered && !total) {
      const probe = await env.DB.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all();
      ready = !!probe?.results?.length;
    }
    const hasMore = offset + hits.length < total;
    return json({ ...empty, hits, total, hasMore, nextOffset: hasMore ? offset + hits.length : null,
      ready, index: layered ? 'layered' : 'legacy' }, 200, headers);
  } catch { return json({ ...empty, ready: false, reason: 'index_unavailable' }, 200, headers); }

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
  if (!USE_RERANK || !env.SILICONFLOW_API_KEY || matches.length <= 1) return matches;
  const pool = matches.slice(0, RERANK_POOL);
  try {
    const documents = pool.map((m) => (m.metadata && m.metadata.text) || '');
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SILICONFLOW_API_KEY}` },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents, top_n: pool.length, return_documents: false }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(20000);
    const r = await fetch(`${SF_BASE}/rerank`, opts);
    const j = r.ok ? await r.json() : null;
    const ranked = (j && j.results) || null;
    if (Array.isArray(ranked) && ranked.length) {
      const ordered = [], seen = new Set();
      for (const it of ranked) {
        const idx = typeof it.index === 'number' ? it.index : -1;
        if (idx >= 0 && idx < pool.length && !seen.has(idx)) {
          seen.add(idx);
          if (typeof it.relevance_score === 'number') pool[idx].rerankScore = it.relevance_score;
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
  if (!USE_CONDENSE || !env.SILICONFLOW_API_KEY || !prevU) return heuristic;
  try {
    const hist = msgs.slice(-5)
      .map((m) => (m.role === 'user' ? '用户：' : '助手：') + String(m.content).slice(0, 200)).join('\n');
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SILICONFLOW_API_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: '你是检索助手。根据对话历史，把用户最后一句可能含指代/省略的追问，改写成一句可独立用于检索的完整问题（补全主语与话题、保留原意）；若末句本身已完整，原样输出。只输出这句问题，不解释、不加引号，40字以内。' },
          { role: 'user', content: hist },
        ],
        temperature: 0, max_tokens: 80, stream: false, thinking: { type: 'disabled' },
      }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(4500);
    const r = await fetch(`${SF_BASE}/chat/completions`, opts);
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

/* 引用检查只证明编号有效和直引文字匹配，不证明解释在义理上正确。
 * 失败或没有引用的答案仍显示提示，但不会成为可重复复用的缓存。 */
function normForMatch(s) {
  return String(s || '').replace(/[\s，。、；：！？「」『』“”"'‘’（）()【】\[\]．·—\-…\n]/g, '');
}
function originalContext(text) {
  const s = String(text || '');
  return s.startsWith('（白话）') ? '' : s.split('\n（白话）')[0];
}
function validateCitations(reply, passages, ctxTexts) {
  const text = String(reply || '');
  const N = passages.length;
  const nums = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const invalid = nums.filter((n) => n < 1 || n > N).length;
  let quoteChecked = 0, quoteOk = 0, quoteUncited = 0;
  const qre = /[「『“"]([^」』”"]+)[」』”"]\s*((?:\[\d+\]\s*)*)/g;
  let mm;
  while ((mm = qre.exec(text))) {
    quoteChecked++;
    const refs = [...mm[2].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (!refs.length) quoteUncited++;
    const quote = normForMatch(mm[1]);
    if (quote && refs.some((n) => {
      if (n < 1 || n > N) return false;
      const src = (ctxTexts && ctxTexts[n - 1]) || passages[n - 1]?.text || '';
      return normForMatch(originalContext(src)).includes(quote);
    })) quoteOk++;
  }
  const faithful = nums.length > 0 && invalid === 0 && quoteOk === quoteChecked;
  const status = invalid || quoteOk !== quoteChecked ? 'failed' : nums.length ? 'passed' : 'unverified';
  return { cited: nums.length, invalid, quoteChecked, quoteOk, quoteUncited, faithful, status,
    scope: 'citation-markers-and-direct-quotes' };
}
function cachedVerification(cached) {
  if (!cached || cached.cacheVersion !== ANSWER_CACHE_VERSION || typeof cached.reply !== 'string' ||
      !cached.reply || !Array.isArray(cached.passages) || !cached.passages.length ||
      !Array.isArray(cached.ctxTexts) || cached.ctxTexts.length !== cached.passages.length ||
      cached.ctxTexts.some((s) => typeof s !== 'string' || !s) || !Array.isArray(cached.sources)) return null;
  const verify = validateCitations(cached.reply, cached.passages, cached.ctxTexts);
  return verify.faithful ? verify : null;
}

// 两个生成通道都不可用时，只展示实际检索到的原文，不让模型在无出处的情况下猜答。
function sourcePreview(passages) {
  const lines = passages.slice(0, 3).map((p, i) => {
    const raw = String(p.text || '').trim();
    const original = originalContext(raw).trim();
    const excerpt = original || raw.replace(/^（白话）/, '');
    return `${i + 1}.《${p.title}》${original ? '原文' : '白话参考'}：${excerpt.slice(0, 90)}${excerpt.length > 90 ? '…' : ''} [${i + 1}]`;
  });
  return '暂时无法生成归纳。先列出检索资料，请点出处核对：\n' + lines.join('\n');
}

async function openAnswerStream(env, model, thinking, messages, skipSiliconFlow = false) {
  const providers = [
    {
      name: 'siliconflow', url: `${SF_BASE}/chat/completions`, key: env.SILICONFLOW_API_KEY,
      body: { model, messages, temperature: 0.3, max_tokens: MAX_TOKENS, stream: true, thinking },
    },
    {
      name: 'deepseek', url: `${DEEPSEEK_BASE}/chat/completions`, key: env.DEEPSEEK_API_KEY,
      body: { model: model === REASONER_MODEL ? 'deepseek-v4-pro' : 'deepseek-flash',
        messages, temperature: 0.3, max_tokens: Math.max(MAX_TOKENS, 1200), stream: true, thinking },
    },
  ];
  for (const p of providers) {
    if (!p.key || (skipSiliconFlow && p.name === 'siliconflow')) continue;
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify(p.body),
      });
      if (res.ok && res.body && (res.headers.get('Content-Type') || '').includes('text/event-stream')) return res;
      console.warn('wenchao chat HTTP', p.name, res.status,
        res.headers.get('x-siliconcloud-trace-id') || '');
    } catch (e) {
      console.warn('wenchao chat connection failed', p.name, e?.name || 'Error');
    }
  }
  return null;
}

/* ---------- API key 鉴权 + 按 key 配额 ----------
   三种调用来源分流：
   ① 带 API key（第三方/服务端）：校验 key，按 key 独立日配额（KEY_DAILY_LIMIT，可被单 key 覆盖）。
   ② 无 key 但来自白名单 Origin/Referer（自家网页）：沿用每 IP 日限额。
   ③ 既无 key 又非自家网页：REQUIRE_KEY_FOR_API=true 时拒绝（默认），否则退回②的匿名路径。
   注意：Origin/Referer 可被 curl 伪造，仅作"是否自家前端"的软判断；真正的鉴权靠 API key。 */
function extractApiKey(req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return (req.headers.get('X-Api-Key') || '').trim();
}
function loadApiKeys(env) {
  // 密钥表存于 Worker Secret API_KEYS（JSON）：{ "<token>": { "name": "...", "limit": 1000, "disabled": false } }
  if (!env.API_KEYS) return null;
  try { const o = JSON.parse(env.API_KEYS); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
function isFirstParty(req) {
  const origin = req.headers.get('Origin') || '';
  if (origin && ALLOW_ORIGINS.includes(origin)) return true;
  const ref = req.headers.get('Referer') || '';
  return ALLOW_ORIGINS.some((o) => ref === o || ref.startsWith(o + '/'));
}
async function authenticate(req, env) {
  const token = extractApiKey(req);
  if (token) {
    const keys = loadApiKeys(env);
    const rec = keys && Object.prototype.hasOwnProperty.call(keys, token) ? keys[token] : null;
    if (!rec || rec.disabled) return { error: true, status: 401, message: 'API key 无效或已停用。' };
    const id = (await sha256(token)).slice(0, 16);
    const limit = Number.isFinite(rec.limit) ? rec.limit : KEY_DAILY_LIMIT;
    return { kind: 'key', id, name: rec.name || 'key', limit };
  }
  if (isFirstParty(req)) return { kind: 'ip' };
  if (REQUIRE_KEY_FOR_API) return { error: true, status: 401, message: '需要 API key：请在请求头加 Authorization: Bearer <你的密钥>。' };
  return { kind: 'ip' };
}
async function enforceQuota(req, env, auth) {
  if (!env.RL) return { limited: false };
  const today = new Date().toISOString().slice(0, 10);
  if (auth.kind === 'key') {
    const k = `akq:${today}:${auth.id}`;
    const c = parseInt((await env.RL.get(k)) || '0', 10);
    if (c >= auth.limit) return { limited: true, message: `本 API key 今日额度（${auth.limit}）已用尽，请明日再来。` };
    await env.RL.put(k, String(c + 1), { expirationTtl: 90000 });
    return { limited: false };
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const k = `d:${today}:${ip}`;
  const c = parseInt((await env.RL.get(k)) || '0', 10);
  if (c >= DAILY_LIMIT) return { limited: true, message: '今日提问已达上限，请明日再来。阿弥陀佛。' };
  await env.RL.put(k, String(c + 1), { expirationTtl: 90000 });
  return { limited: false };
}

async function handleAsk(req, env, headers, ctx) {
  if (!env.SILICONFLOW_API_KEY) return json({ reply: '服务未配置密钥。' }, 500, headers);

  // 鉴权（API key / 自家网页 / 匿名）+ 对应配额
  const auth = await authenticate(req, env);
  if (auth.error) return json({ reply: auth.message }, auth.status, headers);
  const quota = await enforceQuota(req, env, auth);
  if (quota.limited) return json({ reply: quota.message }, 429, headers);

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
  const cacheVerify = cachedVerification(cached);
  const useCache = !!cacheVerify;
  let sfBillingBlocked = false;
  if (!useCache && env.RL) {
    try { sfBillingBlocked = (await env.RL.get(SF_BILLING_BREAKER)) === '1'; } catch {}
  }

  // 检索（缓存命中则复用其 passages/sources）
  let passages = [], sources = [], system = '';
  let ctxTexts = [];   // 喂给模型的父段落正文（按 passage 序），用于引用逐字自检
  let retrievalErrored = false;   // 检索是否真的报错（多为嵌入/重排上游繁忙或额度耗尽）；据实告知，不误判"未见相关开示"
  let earlyReply = '';            // 护栏短路：命中则直接回该句，不调用生成模型、不写缓存
  if (useCache) {
    passages = cached.passages; sources = cached.sources; ctxTexts = cached.ctxTexts;
  } else {
    let matches = [], vectorFailed = false;
    try {
      const filter = articleScoped ? { aid: articleId } : null;
      const { queries, terms } = sfBillingBlocked
        ? { queries: [retrievalQ], terms: naiveTerms(retrievalQ) }
        : await buildRetrieval(env, retrievalQ);  // 付款故障期间不再等上游改写
      const [embedding, lexical] = await Promise.allSettled([
        sfBillingBlocked ? Promise.reject(new Error('embed_http_402')) : embed(env, queries),
        lexicalSearch(env, terms, filter),                              // D1 全文(关键词)召回，与向量化并行
      ]);
      const lex = lexical.status === 'fulfilled' ? lexical.value : [];
      let pools = [];
      if (embedding.status === 'fulfilled') {
        const queried = await Promise.allSettled(
          embedding.value.map((qv) => queryKnowledgeBase(env, qv, filter))
        );
        pools = queried.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        vectorFailed = !pools.length;
      } else {
        vectorFailed = true;
        if (embedding.reason?.message === 'embed_http_402') {
          if (!sfBillingBlocked && env.RL) {
            const remember = env.RL.put(SF_BILLING_BREAKER, '1',
              { expirationTtl: SF_BILLING_BREAKER_TTL }).catch(() => {});
            if (ctx?.waitUntil) ctx.waitUntil(remember);
          }
          sfBillingBlocked = true;
        }
        if (!sfBillingBlocked || embedding.reason?.message !== 'embed_http_402')
          console.warn('wenchao embedding failed', embedding.reason?.name || 'Error',
            embedding.reason?.message || '');
      }
      const vecMerged = mergeMatchPools(pools);                          // 多路向量并集(各保留最高分)
      // 向量 + 关键词两路 RRF 融合；未开混合或关键词无命中时退回纯向量序
      matches = (USE_HYBRID && lex.length) ? fuseRRF([vecMerged, lex]) : vecMerged;
      // 某一路失败但另一路有真实段落，仍可据文作答；全部无命中时不能把服务故障说成文钞没有开示。
      retrievalErrored = !matches.length &&
        (vectorFailed || lexical.status === 'rejected');
      if (vectorFailed && embedding.status === 'fulfilled') console.warn('wenchao vector query failed');
      if (lexical.status === 'rejected') console.warn('wenchao lexical search failed');
    } catch (e) {
      retrievalErrored = true;
      console.warn('wenchao retrieval failed', e?.name || 'Error');
    }
    // ① 去重：原文近似相同的（如精选读本与文钞重出）只保留一条，得到候选池
    matches = dedupeMatches(matches);
    // ② 交叉编码器重排序：把真正最相关的段排到前面，再取 TOP_K 喂给 DeepSeek
    if (!vectorFailed) matches = await rerankMatches(env, retrievalQ, matches);
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
4. 区分原文与解释：回答使用「原文引述」与「辅助解释」两个简短小标题。原文引述只摘录【资料】中不带（白话）标记的原文，逐字引用并紧接 [n]；若只有白话资料，明确说明未检索到可直引原文，不把白话冒充大师原话。辅助解释只作资料支持的转述，每点附 [n]，不要用引号把解释包装成原话。
5. 恭敬平实：不扮演佛菩萨或祖师口吻、不预言吉凶、不轻下因果定论；直接作答，不写「根据资料」「综上所述」之类的套话。
6. 紧扣问题、简明，控制在约 ${ANSWER_CHARS} 字以内。

【资料】
${context}`;
  }
  // 检索护栏（贴「不妄语·宁可不答，不可妄说」）：
  //  ① 检索服务本身故障（嵌入/重排上游繁忙或额度耗尽）→ 据实告知，绝不诬为"未见开示"，不调用生成、不写缓存；
  //  ② 检索正常但零命中 → 直接拒答，不调用生成模型（省算力，且从机制上杜绝无据发挥）。
  if (!useCache) {
    if (retrievalErrored) earlyReply = '抱歉，文钞检索服务暂时不可用（上游繁忙或额度受限），请稍后再试。南无阿弥陀佛。';
    else if (!passages.length) earlyReply = '文钞中未见相关开示。可以换个说法，或就具体的净土法门、修持问题再问。';
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
        const v = cacheVerify;
        send({ type: 'done', verify: v });
        keepLog(ctx, logQuestion(env, req, {
          q: lastU, retrievalQ, hits: passages.length,
          topScore: passages[0] && passages[0].score, cited: v ? v.cited : sources.length,
          verifyOk: v ? !!v.faithful : null, cached: true, early: false, articleId,
        }));
        controller.close();
        return;
      }
      // 护栏短路：检索故障 / 零命中 → 直接回定句，不调用生成模型、不写缓存
      if (earlyReply) {
        send({ type: 'delta', text: earlyReply });
        send({ type: 'done', verify: null });
        // 这一支正是「问了但答不上来」——痛点分析里最该看的一类，必须记
        keepLog(ctx, logQuestion(env, req, {
          q: lastU, retrievalQ, hits: passages.length,
          topScore: passages[0] && passages[0].score, cited: 0,
          verifyOk: null, cached: false, early: true, articleId,
        }));
        controller.close();
        return;
      }
      // 难题路由：开关打开且属比较/辨析类长问时，改用 reasoner（推理 token 不在 delta.content 里，自然不外显）
      const hard = USE_REASONER_FOR_HARD && isHardQuestion(retrievalQ);
      const model = hard ? REASONER_MODEL : CHAT_MODEL;
      const thinking = hard ? { type: 'enabled' } : { type: 'disabled' };  // 默认非思考(等价旧 deepseek-chat)；仅难题路由开思考
      let full = '', sawDone = false, finishReason = null;
      try {
        const ds = await openAnswerStream(env, model, thinking,
          [{ role: 'system', content: system }, ...msgs], sfBillingBlocked);
        if (!ds) {
          send({ type: 'delta', text: sourcePreview(passages) });
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
            if (d === '[DONE]') { sawDone = true; continue; }
            try {
              const j = JSON.parse(d);
              const choice = j.choices && j.choices[0];
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              const t = (choice && choice.delta && choice.delta.content) || '';
              if (t) { full += t; send({ type: 'delta', text: t }); }
            } catch { /* 跳过半行 */ }
          }
        }
      } catch (e) {
        console.warn('wenchao chat stream failed', e?.name || 'Error');
      }
      const completed = sawDone && (!finishReason || finishReason === 'stop');
      if (!full) send({ type: 'delta', text: sourcePreview(passages) });
      else if (!completed) send({ type: 'delta', text: '\n\n回答未完整生成，以上内容不完整，请重试。' });
      // 先核验再决定是否缓存。保留模型真正看到的公开资料，缓存命中用同一证据复核。
      const vf = full && completed ? validateCitations(full, passages, ctxTexts) : null;
      if (cacheable && env.RL && vf?.faithful) {
        try {
          await env.RL.put(ckey, JSON.stringify({ cacheVersion: ANSWER_CACHE_VERSION,
            reply: full, cite, sources, passages, ctxTexts, verify: vf }), { expirationTtl: CACHE_TTL });
        } catch { console.warn('wenchao answer cache write failed'); }
      }
      send({ type: 'done', verify: vf });
      keepLog(ctx, logQuestion(env, req, {
        q: lastU, retrievalQ, hits: passages.length,
        topScore: passages[0] && passages[0].score, cited: vf ? vf.cited : sources.length,
        verifyOk: vf ? !!vf.faithful : null, cached: false, early: false, articleId,
      }));
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
}

/* ---------- 提问留存（2026-09-09）：把用户真实问的问题落库，作为痛点分析的一手来源 ----------
 * 为什么要存：站点流量只能回答「有多少人来、点了哪页」，回答不了「用户到底想知道什么、
 * 哪些问题我们答不好」。后者才是内容选题与检索调优的依据，此前一直丢弃。
 *
 * 🔒 隐私口径（与 foyue.org/admin 后台既有红线一致：不留可认人之物）：
 *   · 只存问题文本与检索质量指标，**不存答案全文**（答案可由问题+知识库复现，存了徒增泄露面）
 *   · 不存 IP、不存 User-Agent、不存 cookie；客户端只留一个每日轮换盐的哈希前缀，
 *     用于粗略区分「同一天里的同一人问了几个问题」，跨天即失联，无法反查到人
 *   · 表独立于知识库表，可随时整表 DROP 而不影响问答功能
 */
const QLOG_RETAIN_DAYS = 180;   // 超过此天数的提问自动清理（按需回看痛点，不做长期留存）

/** 让落库任务在响应结束后仍能跑完。
 *
 * ⚠️ 这是 2026-09-10 修复的一个真实故障：三处 logQuestion 都是「调用但不 await」的
 * fire-and-forget 写法，而 Workers 运行时在响应流 close 之后会立即回收执行上下文，
 * D1 写入还没发出就被杀掉——表结构完好，却永远 0 条记录。
 * 凡是响应返回后才需要完成的副作用（落库、上报、清理），都必须交给 ctx.waitUntil。
 * 本文件的 TTS 落桶（见 handleTts）早就是这个写法，此处属于遗漏。
 */
function keepLog(ctx, promise) {
  if (ctx && ctx.waitUntil) ctx.waitUntil(promise);
  return promise;
}

async function ensureQlog(env) {
  if (!env.DB) return false;
  try {
    // 必须用 prepare().run() 而非 exec()：D1 的 exec() 对 DDL 支持有限，
    // 建表会失败并使本函数返回 false，导致调用方直接 return、INSERT 永不执行
    //（2026-09-10 线上实证：手工 SQL 能建表能插入，但 Worker 里走 exec() 就是不落库）。
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS ask_qlog (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, ' +
      'q TEXT NOT NULL, qlen INTEGER, retrieval_q TEXT, ' +
      'hits INTEGER, top_score REAL, cited INTEGER, verify_ok INTEGER, ' +
      'cached INTEGER, early INTEGER, article_id TEXT, client TEXT)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS ask_qlog_day ON ask_qlog(day)').run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS ask_qlog_ts ON ask_qlog(ts DESC)').run();
    return true;
  } catch (e) {
    // 建表失败必须留痕，否则下次排查又要从零复现（上次就因静默 catch 误判了根因）
    console.error('[qlog] ensure failed:', e && e.message);
    return false;
  }
}

/** 每日轮换盐的客户端指纹：同一天内可区分不同人，跨天即断，无法反查身份。 */
async function dayClient(req) {
  try {
    const raw = req.headers.get('cf-connecting-ip') || '';
    if (!raw) return '';
    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    return (await sha256(day + '|' + raw)).slice(0, 12);
  } catch { return ''; }
}

/** best-effort 落库：任何异常都吞掉，绝不影响问答本身。 */
async function logQuestion(env, req, rec) {
  if (!env.DB) return;
  try {
    if (!await ensureQlog(env)) return;
    const now = Date.now();
    const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    const q = String(rec.q || '').slice(0, 500);      // 截断：过长多为粘贴的整段文字，无分析价值
    if (!q.trim()) return;
    await env.DB.prepare(
      'INSERT INTO ask_qlog (ts, day, q, qlen, retrieval_q, hits, top_score, cited, verify_ok, ' +
      'cached, early, article_id, client) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)'
    ).bind(
      now, day, q, q.length,
      String(rec.retrievalQ || '').slice(0, 500),
      rec.hits | 0, rec.topScore == null ? null : Number(rec.topScore),
      rec.cited | 0, rec.verifyOk == null ? null : (rec.verifyOk ? 1 : 0),
      rec.cached ? 1 : 0, rec.early ? 1 : 0,
      String(rec.articleId || '').slice(0, 64),
      await dayClient(req),
    ).run();
    // 顺手清理过期记录（低频，失败无碍）
    if (Math.random() < 0.02) {
      await env.DB.prepare('DELETE FROM ask_qlog WHERE ts < ?1')
        .bind(now - QLOG_RETAIN_DAYS * 86400_000).run();
    }
  } catch (e) {
    // 落库失败绝不拖累问答，但要留痕便于排查
    console.error('[qlog] insert failed:', e && e.message);
  }
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

/* ---------- 统一控制台接口（foyue.org/admin 跨站调用） ----------
   与播经台、须弥山、自知录同一枚 ADMIN_TOKEN；仅放行 foyue.org 来源。 */
const ADMIN_ORIGINS = ['https://foyue.org', 'https://www.foyue.org'];
function adminCors(origin) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ADMIN_ORIGINS.includes(origin) ? origin : ADMIN_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
async function handleUnifiedAdmin(req, env, pathname, origin) {
  const h = adminCors(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (!env.ADMIN_TOKEN) return json({ error: '未配置 ADMIN_TOKEN' }, 503, h);
  if (req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: '口令错误' }, 401, h);

  // 概览：反馈计数 + 知识库规模 + 今日问答量
  if (pathname === '/api/admin/stat') {
    let up = 0, down = 0, total = 0, pending = 0;
    if (env.RL) {
      const list = await env.RL.list({ prefix: 'fb:', limit: 1000 });
      for (const k of list.keys.slice(-300)) {
        const v = await env.RL.get(k.name);
        if (!v) continue;
        let o; try { o = JSON.parse(v); } catch { continue; }
        total++;
        if (o.vote === 'up') up++;
        else if (o.vote === 'down') { down++; if (!o.handled) pending++; }
      }
    }
    let kb = null;
    try { const d = await env.VEC.describe(); kb = d.vectorsCount ?? d.vectorCount ?? null; } catch { /* 可选 */ }
    return json({ up, down, total, pendingCorrections: pending, kb }, 200, h);
  }

  // 提问留存：热门问题 / 答不上来的问题（痛点分析用；只出问题文本与检索指标，无身份信息）
  if (pathname === '/api/admin/questions') {
    if (!env.DB) return json({ items: [], note: '未绑定 D1，提问留存未启用' }, 200, h);
    try {
      const u = new URL(req.url);
      const days = Math.min(Number(u.searchParams.get('days') || 7), 90);
      const kind = u.searchParams.get('kind') || 'recent';   // recent | unanswered | top
      const since = Date.now() - days * 86400_000;
      let sql;
      if (kind === 'unanswered') {
        // 答不上来的：护栏短路(零命中/检索故障)，或有答案但一条都没引用到原文
        sql = 'SELECT q, ts, hits, top_score, cited, early FROM ask_qlog ' +
              'WHERE ts > ?1 AND (early = 1 OR hits = 0 OR cited = 0) ORDER BY ts DESC LIMIT 200';
      } else if (kind === 'top') {
        // 热门：同一问题被不同人反复问 —— 最该补内容的方向
        sql = 'SELECT q, COUNT(*) n, MAX(ts) ts, AVG(hits) hits, SUM(early) early ' +
              'FROM ask_qlog WHERE ts > ?1 GROUP BY q ORDER BY n DESC, ts DESC LIMIT 100';
      } else {
        sql = 'SELECT q, ts, hits, top_score, cited, early, verify_ok FROM ask_qlog ' +
              'WHERE ts > ?1 ORDER BY ts DESC LIMIT 200';
      }
      const { results } = await env.DB.prepare(sql).bind(since).all();
      const tot = await env.DB.prepare('SELECT COUNT(*) n FROM ask_qlog WHERE ts > ?1').bind(since).first();
      const bad = await env.DB.prepare(
        'SELECT COUNT(*) n FROM ask_qlog WHERE ts > ?1 AND (early = 1 OR hits = 0 OR cited = 0)'
      ).bind(since).first();
      const askers = await env.DB.prepare(
        "SELECT COUNT(DISTINCT client) n FROM ask_qlog WHERE ts > ?1 AND client != ''"
      ).bind(since).first();
      return json({
        items: results || [], kind, days,
        total: tot?.n || 0, unanswered: bad?.n || 0, askers: askers?.n || 0,
      }, 200, h);
    } catch (e) {
      return json({ items: [], note: '提问表尚未建立（需有人问过至少一次）' }, 200, h);
    }
  }

  // 反馈明细（需更正的排前，供集中处理）
  if (pathname === '/api/admin/feedback') {
    if (!env.RL) return json({ items: [] }, 200, h);
    const list = await env.RL.list({ prefix: 'fb:', limit: 1000 });
    const keys = list.keys.map(k => k.name).sort().slice(-150).reverse();
    const items = [];
    for (const k of keys) {
      const v = await env.RL.get(k);
      if (!v) continue;
      let o; try { o = JSON.parse(v); } catch { continue; }
      items.push({ key: k, ...o });
    }
    items.sort((a, b) => (a.vote === 'down' && !a.handled ? -1 : 1) - (b.vote === 'down' && !b.handled ? -1 : 1));
    return json({ items }, 200, h);
  }

  // 标记某条反馈已处理
  if (pathname === '/api/admin/feedback-handled' && req.method === 'POST') {
    if (!env.RL) return json({ error: 'KV 未绑定' }, 503, h);
    let body = {}; try { body = await req.json(); } catch { /* 空 */ }
    const key = String(body.key || '');
    if (!key.startsWith('fb:')) return json({ error: '参数不合法' }, 400, h);
    const v = await env.RL.get(key);
    if (!v) return json({ error: '记录不存在' }, 404, h);
    let o; try { o = JSON.parse(v); } catch { return json({ error: '数据损坏' }, 500, h); }
    o.handled = body.handled !== false;
    await env.RL.put(key, JSON.stringify(o));
    return json({ ok: true }, 200, h);
  }

  return json({ error: '接口不存在' }, 404, h);
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
  let searchStatus = 'unavailable';
  if (env.DB) {
    try { searchStatus = (await env.DB.prepare("SELECT value FROM search_state WHERE id='status'").first())?.value || 'pending'; }
    catch { /* 尚未建分层搜索索引。 */ }
  }
  return json({
    ok: true,
    service: 'wenchao-ai',
    searchStatus,
    searchReady: searchStatus === 'ready',
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
    apiKeyAuth: !!loadApiKeys(env),       // 是否已配置 API_KEYS 密钥表
    apiKeys: (function () { const k = loadApiKeys(env); return k ? Object.keys(k).length : 0; })(),
    requireKey: REQUIRE_KEY_FOR_API,      // 非自家网页是否强制要求 API key
    keyDailyLimit: KEY_DAILY_LIMIT,
    dailyLimit: DAILY_LIMIT,
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

/* ---------- 朗读：按需生成 + R2 懒缓存 ----------
   前端契约：POST { text, layer:'o'|'t', voice } → 音频字节(audio/mpeg)。
   命中 R2 直接返回(不计配额)；未命中受「生成配额」约束后调 CosyVoice2，并后台落桶。 */
async function ttsGenQuota(req, env) {
  // 独立于问答日额度；只对生成(cache-miss)计数，命中/重复播放不消耗。
  if (!env.RL) return { limited: false };
  const today = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const k = `ttsgen:${today}:${ip}`;
  const c = parseInt((await env.RL.get(k)) || '0', 10);
  if (c >= TTS_GEN_DAILY) return { limited: true, message: '今日朗读生成已达上限，请明日再来。阿弥陀佛。' };
  await env.RL.put(k, String(c + 1), { expirationTtl: 90000 });
  return { limited: false };
}
async function handleTts(req, env, ctx, origin) {
  const aCors = cors(origin);
  const jerr = (obj, status) => json(obj, status, { 'Content-Type': 'application/json', ...aCors });
  if (!env.TTS) return jerr({ error: '朗读存储未配置。' }, 500);
  if (!env.SILICONFLOW_API_KEY) return jerr({ error: '朗读密钥未配置。' }, 500);

  // 鉴权沿用问答同一套（API key / 自家网页 / 匿名）
  const auth = await authenticate(req, env);
  if (auth.error) return jerr({ error: auth.message }, auth.status);

  let body;
  try { body = await req.json(); } catch { body = null; }
  const rawText = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!rawText) return jerr({ error: '缺少文本。' }, 400);
  const layer = body && body.layer === 'o' ? 'o' : 't';   // o=原文 t=白话（默认白话）
  let voice = body && typeof body.voice === 'string' ? body.voice : TTS_DEFAULT_VOICE;
  if (!TTS_VOICES.includes(voice)) voice = TTS_DEFAULT_VOICE;
  const text = rawText.slice(0, TTS_MAX_CHARS);

  // 确定性缓存键：版本+音色+分层+文本哈希 → 文本一改即失效、重复播放必命中
  const digest = await sha256(TTS_VER + '|' + TTS_MODEL + '|' + voice + '|' + layer + '|' + text);
  const key = `${TTS_VER}/${layer}/${voice}/${digest}.${TTS_FORMAT}`;
  const audioType = 'audio/' + (TTS_FORMAT === 'mp3' ? 'mpeg' : TTS_FORMAT);
  const audioHeaders = { 'Content-Type': audioType, 'Cache-Control': 'public, max-age=31536000, immutable', ...aCors };

  // ① 命中 R2：直接回，不计配额、不再生成
  const hit = await env.TTS.get(key);
  if (hit) return new Response(hit.body, { headers: { ...audioHeaders, 'X-Tts-Cache': 'hit' } });

  // ② 未命中：受生成配额约束，再调 CosyVoice2
  const quota = await ttsGenQuota(req, env);
  if (quota.limited) return jerr({ error: quota.message }, 429);

  const spoken = normalizeReading(text);   // 只影响发音，不影响 key（key 用原文，便于按屏显文本命中）
  let r;
  try {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SILICONFLOW_API_KEY}` },
      body: JSON.stringify({ model: TTS_MODEL, input: spoken, voice: `${TTS_MODEL}:${voice}`, response_format: TTS_FORMAT }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(30000);
    r = await fetch(`${SF_BASE}/audio/speech`, opts);
  } catch (e) {
    return jerr({ error: '朗读生成超时或失败：' + ((e && e.message) || e) }, 502);
  }
  if (!r.ok) return jerr({ error: '朗读上游错误 ' + r.status + ' ' + (await r.text()).slice(0, 200) }, 502);

  const buf = await r.arrayBuffer();
  const put = env.TTS.put(key, buf, {
    httpMetadata: { contentType: audioType },
    customMetadata: { layer, voice, model: TTS_MODEL, ver: TTS_VER, len: String(text.length) },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;   // 后台落桶，不阻塞返回
  return new Response(buf, { headers: { ...audioHeaders, 'X-Tts-Cache': 'miss' } });
}

/* 读音报错：用户听到读错的字词，一键上报，攒起来供管理端核实、扩充 READ_DICT。 */
/* 段落翻译：先查 R2，未命中才向 DharmaMitra 要，要到了后台落桶。
   与 handleTts 同一套骨架，差别只在上游与载荷格式。 */
async function handleTranslate(req, env, ctx, origin) {
  const aCors = cors(origin);
  const jerr = (obj, status) => json(obj, status, { 'Content-Type': 'application/json', ...aCors });
  if (!env.TTS) return jerr({ error: '译文存储未配置。' }, 500);

  const auth = await authenticate(req, env);
  if (auth.error) return jerr({ error: auth.message }, auth.status);

  let body;
  try { body = await req.json(); } catch { body = null; }
  const rawText = body && typeof body.text === 'string' ? body.text.trim() : '';
  if (!rawText) return jerr({ error: '缺少文本。' }, 400);

  const langKey = body && typeof body.lang === 'string' ? body.lang.toLowerCase().slice(0, 8) : 'en';
  const target = TR_LANGS[langKey] || TR_LANGS.en;
  const lang = TR_LANGS[langKey] ? langKey : 'en';
  const text = rawText.slice(0, TR_MAX_CHARS);
  // 上下文只是给上游做连贯性参考，长度掐住即可
  const context = body && typeof body.context === 'string' ? body.context.slice(0, 3000) : '';

  /* 缓存键刻意「不含 context」。若把前文并进键，每篇的前文都不同，命中率立刻归零，
     缓存就白做了；而同一段落在不同上下文下的译文差异很小，不值得为此放弃复用。
     代价是：首次翻译时的上下文会被固化进这一段的译文，后来者拿到的是那一版。 */
  const digest = await sha256(TR_VER + '|' + target + '|' + text);
  const key = `tr/${TR_VER}/${lang}/${digest}.json`;
  const hdrs = { 'Content-Type': 'application/json; charset=utf-8', ...aCors };

  // ① 命中：直接回，不计配额、不惊动上游
  const hit = await env.TTS.get(key);
  if (hit) {
    return new Response(hit.body, { headers: { ...hdrs, 'X-Tr-Cache': 'hit' } });
  }

  // ② 未命中：先受配额约束，再去要
  const quota = await trGenQuota(req, env);
  if (quota.limited) return jerr({ error: quota.message }, 429);

  let r;
  try {
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_chinese: text,
        focus: 'chinese',
        target_language: target,
        context,
        style_instruction: TR_STYLE,
      }),
    };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(TR_TIMEOUT_MS);
    r = await fetch(TR_ENDPOINT, opts);
  } catch (e) {
    return jerr({ error: '翻译服务暂时不可达，请稍后再试。' }, 502);
  }
  if (!r.ok) return jerr({ error: '翻译上游错误 ' + r.status }, 502);

  let up;
  try { up = await r.json(); } catch { up = null; }
  const translation = up && typeof up.translation === 'string' ? up.translation.trim() : '';
  if (!translation) return jerr({ error: '翻译返回为空。' }, 502);

  const payload = JSON.stringify({ translation, lang });
  const put = env.TTS.put(key, payload, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { lang, ver: TR_VER, len: String(text.length) },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;   // 后台落桶，不阻塞返回
  return new Response(payload, { headers: { ...hdrs, 'X-Tr-Cache': 'miss' } });
}

async function trGenQuota(req, env) {
  // 与问答、朗读各自独立；只对生成(cache-miss)计数，命中不消耗。
  // 这道闸主要不是防我们自己的用户，是防我们把免费公益服务用垮。
  if (!env.RL) return { limited: false };
  const today = new Date().toISOString().slice(0, 10);
  const ip = req.headers.get('CF-Connecting-IP') || 'anon';
  const k = `trgen:${today}:${ip}`;
  const c = parseInt((await env.RL.get(k)) || '0', 10);
  if (c >= TR_GEN_DAILY) return { limited: true, message: '今日翻译已达上限，请明日再来。阿弥陀佛。' };
  await env.RL.put(k, String(c + 1), { expirationTtl: 90000 });
  return { limited: false };
}

async function handleTtsReport(req, env, headers) {
  const auth = await authenticate(req, env);
  if (auth.error) return json({ error: auth.message }, auth.status, headers);
  let b; try { b = await req.json(); } catch { b = null; }
  if (!b) return json({ error: '无效请求' }, 400, headers);
  const rec = {
    t: new Date().toISOString(),
    a: String(b.a || '').slice(0, 40),
    seg: String(b.seg == null ? '' : b.seg).slice(0, 8),
    layer: b.layer === 'o' ? 'o' : 't',
    text: String(b.text || '').slice(0, 300),
    note: String(b.note || '').slice(0, 200),
    voice: String(b.voice || '').slice(0, 24),
  };
  if (env.RL) {
    const k = 'ttsreport:list';
    let arr = [];
    try { arr = JSON.parse((await env.RL.get(k)) || '[]'); } catch {}
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(rec);
    if (arr.length > 500) arr = arr.slice(0, 500);
    await env.RL.put(k, JSON.stringify(arr));
  }
  return json({ ok: true }, 200, headers);
}

export default {
  async fetch(req, env, ctx) {
    try {
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
    // 统一控制台（foyue.org/admin）跨站取用：Bearer ADMIN_TOKEN，与各站同一枚口令
    if (pathname.startsWith('/api/admin/')) return handleUnifiedAdmin(req, env, pathname, origin);
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers });
    if (pathname === '/index') return handleIndex(req, env, url, headers);
    if (pathname === '/tts') return handleTts(req, env, ctx, origin);
    if (pathname === '/translate') return handleTranslate(req, env, ctx, origin);
    if (pathname === '/tts/report') return handleTtsReport(req, env, headers);
    if (pathname === '/feedback') return handleFeedback(req, env, headers);
    if (pathname === '/search') return handleSearch(req, env, headers);
    if (pathname === '/admin/data') return handleAdminData(req, env, headers);
    return handleAsk(req, env, headers, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
