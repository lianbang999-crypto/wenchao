/* 印光法师文钞 · AI 助读代理（DeepSeek）
 *
 * 作用：前端只调用本代理，DeepSeek 密钥仅存于 Worker Secret（DEEPSEEK_API_KEY），
 *       绝不下发到浏览器。代理取「本篇原文+白话」作依据，注入价值观约束的 system prompt，
 *       再转调 DeepSeek，返回 { reply, cite }。
 *
 * 前端契约：POST { articleId, title, messages:[{role,content}…] } → { reply, cite }
 *
 * 部署：
 *   cd workers/ai-proxy
 *   npx wrangler deploy
 *   npx wrangler secret put DEEPSEEK_API_KEY      # 交互输入密钥，不写入任何文件
 *   （可选护额度）创建并绑定 KV：见 wrangler.toml 注释
 */

const ALLOW_ORIGINS = [
  'https://wenchao.foyue.org',
  'https://wenchao.pages.dev',
  'http://localhost:4188',
  'http://127.0.0.1:4188',
];
const SITE_BASE = 'https://wenchao.foyue.org';  // 取本篇原文作依据（站点须已上线）
const MODEL = 'deepseek-chat';                  // V3：快而省，适合据文答疑
const MAX_CTX_CHARS = 6000;                     // 注入原文上限（控成本）
const DAILY_LIMIT = 60;                         // 每 IP 每日提问上限（护额度，需绑定 KV）

const SYSTEM = `你是「印光法师文钞」白话学习平台的助读员，协助读者理解印光大师的净土教诲。务必遵守：
1. 只依据【本篇提供的原文与白话】作答，不臆造、不杜撰、不夸大；本篇未涉及者，明说「本篇未及」，并建议查阅原文或请教善知识。
2. 引用大师原话须标明出自本篇，尽量用原文，不改一字。
3. 不扮演佛菩萨或祖师口吻，不自称证悟，不预言吉凶、不轻下因果定论。
4. 持净土正见，不贬抑正法、不掺杂外道邪说；白话只为辅助理解，义理以大师原文为准。
5. 语气恭敬、平实、简明。`;

function cors(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

async function fetchArticle(articleId) {
  if (!articleId) return '';
  try {
    const r = await fetch(`${SITE_BASE}/data/articles/${articleId}.json`);
    if (!r.ok) return '';
    const a = await r.json();
    const orig = [], trans = [];
    for (const s of a.segments || []) {
      (s.orig || []).forEach((p) => orig.push(p));
      (s.trans || []).forEach((p) => trans.push(p));
    }
    let ctx = `《${a.title}》\n【原文】\n${orig.join('\n')}`;
    if (trans.length) ctx += `\n【白话】\n${trans.join('\n')}`;
    return ctx.slice(0, MAX_CTX_CHARS);
  } catch {
    return '';
  }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const headers = { 'Content-Type': 'application/json', ...cors(origin) };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers });
    if (!env.DEEPSEEK_API_KEY) {
      return new Response(JSON.stringify({ reply: '服务未配置密钥。' }), { status: 500, headers });
    }

    // 限流：每 IP 每日上限（绑定 KV「RL」后生效；未绑定则跳过）
    if (env.RL) {
      const ip = req.headers.get('CF-Connecting-IP') || 'anon';
      const key = `d:${new Date().toISOString().slice(0, 10)}:${ip}`;
      const n = parseInt((await env.RL.get(key)) || '0', 10);
      if (n >= DAILY_LIMIT) {
        return new Response(JSON.stringify({ reply: '今日提问已达上限，请明日再来。阿弥陀佛。' }),
          { status: 429, headers });
      }
      await env.RL.put(key, String(n + 1), { expirationTtl: 90000 });
    }

    let body;
    try { body = await req.json(); } catch { body = null; }
    const msgs = body && Array.isArray(body.messages)
      ? body.messages.filter((m) => m && m.role && typeof m.content === 'string').slice(-8)
      : [];
    if (!msgs.length) {
      return new Response(JSON.stringify({ reply: '请输入问题。' }), { status: 400, headers });
    }

    const ctx = await fetchArticle(body.articleId);
    const system = SYSTEM + (ctx ? `\n\n——本篇内容如下，请据此作答——\n${ctx}` : '');

    let ds;
    try {
      ds = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: system }, ...msgs],
          temperature: 0.3,   // 低温保真，少臆造
          max_tokens: 1200,
          stream: false,
        }),
      });
    } catch {
      return new Response(JSON.stringify({ reply: '上游服务连接失败，请稍后重试。' }),
        { status: 502, headers });
    }
    if (!ds.ok) {
      return new Response(JSON.stringify({ reply: '上游服务繁忙，请稍后重试。' }),
        { status: 502, headers });
    }
    const data = await ds.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content || '').trim() || '（无回复）';
    const cite = body.title ? `依据《${body.title}》原文 · 仅供参考` : '仅供参考，义理以大师原文为准';
    return new Response(JSON.stringify({ reply, cite }), { headers });
  },
};
