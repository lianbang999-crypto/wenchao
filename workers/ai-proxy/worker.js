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
  'https://www.wenchao.foyue.org',
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

/* ---------- 建库：把一篇按自然段切成「原文(+白话)」段块 ----------
 * migrate 常把整篇并成一个 segment（orig[]/trans[] 各含多段），故须按段拆，
 * 否则长文钞只剩一块且被截断、检索会漏。 */
function chunksOf(art) {
  const out = [];
  let idx = 0;
  const push = (text) => {
    text = (text || '').trim();
    if (!text) return;
    out.push({
      id: `${art.id}#${idx}`,
      text: text.slice(0, META_TEXT_MAX),
      meta: { aid: art.id, title: art.title || '', vol: art.volumeName || '', seg: idx },
    });
    idx++;
  };
  (art.segments || []).forEach((s) => {
    const O = s.orig || (s.o ? [s.o] : []);
    const T = s.trans || [];
    if (O.length && O.length === T.length) {        // 对齐：逐段原文+白话成一块
      for (let i = 0; i < O.length; i++) push(O[i] + (T[i] ? '\n（白话）' + T[i] : ''));
    } else {                                        // 不齐：原文段、白话段各自成块
      O.forEach((p) => push(p));
      T.forEach((p) => push('（白话）' + p));
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
  const userMsgs = msgs.filter((m) => m.role === 'user');
  const lastU = userMsgs.length ? userMsgs[userMsgs.length - 1].content : '';
  if (!lastU.trim()) return json({ reply: '请输入问题。' }, 400, headers);
  // ② 多轮追问：指代/短问/承上时，并入上一问做检索（否则"出处呢""再展开"会检索不到）
  const prevU = userMsgs.length > 1 ? userMsgs[userMsgs.length - 2].content : '';
  let retrievalQ = lastU;
  if (prevU && (lastU.length < 12 ||
      /它|他|她|这|那|上(面|述|文)|继续|再|还有|为什[么麽]|怎[么样]|出处|展开|具体|详细|例子|呢[？?]?$/.test(lastU))) {
    retrievalQ = prevU + '。' + lastU;
  }

  // 答案缓存：仅单轮问答（多轮依赖上下文，不缓存以免串味）
  const cacheable = userMsgs.length === 1;
  const ckey = 'a:' + (await sha256(retrievalQ.trim()));
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
      const [qv] = await embed(env, [retrievalQ]);
      const res = await env.VEC.query(qv, { topK: TOP_K * 2, returnMetadata: 'all' });
      matches = res.matches || [];
    } catch { /* 检索失败则裸答 */ }
    // ① 去重：原文近似相同的（如精选读本与文钞重出）只保留一条，凑足 TOP_K
    const seen = new Set(), uniq = [];
    for (const m of matches) {
      const orig = (((m.metadata && m.metadata.text) || '').split('\n（白话）')[0]).replace(/\s/g, '');
      const key = orig.slice(0, 40);
      if (!key || seen.has(key)) continue;
      seen.add(key); uniq.push(m);
      if (uniq.length >= TOP_K) break;
    }
    matches = uniq;
    const ctxBlocks = [], srcMap = new Map();
    matches.forEach((m, i) => {
      const md = m.metadata || {};
      const n = i + 1;
      ctxBlocks.push(`【${n}】《${md.title || ''}》\n${md.text || ''}`);
      passages.push({ n, aid: md.aid || '', title: md.title || '', text: md.text || '' });
      if (md.aid && !srcMap.has(md.aid)) srcMap.set(md.aid, md.title || '');
    });
    sources = [...srcMap].slice(0, 8).map(([id, title]) => ({ id, title }));
    const context = ctxBlocks.join('\n\n') || '（未检索到相关资料）';
    system = `你是「印光法师文钞」知识库助手。下面【资料】是依用户问题检索到的文钞段落，各以【n】编号。务必：
1. 只依据这些资料作答，不引入资料以外的说法、不自行发挥；资料未涵盖或问题与文钞/净土无关，就说「文钞中未见相关开示」，绝不编造。
2. 每个论断后用方括号标出所依据的资料编号，如 [1] 或 [2][5]，以便读者点开核对原文；可直接引用大师原文并加引号。
3. 不扮演佛菩萨或祖师口吻，不预言吉凶、不轻下因果定论；语气恭敬平实。
4. 简明扼要，控制在约 ${ANSWER_CHARS} 字以内。

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
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers });
    if (pathname === '/index') return handleIndex(req, env, url, headers);
    if (pathname === '/feedback') return handleFeedback(req, env, headers);
    if (pathname === '/admin/data') return handleAdminData(req, env, headers);
    return handleAsk(req, env, headers);
  },
};
