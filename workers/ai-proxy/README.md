# AI 助读知识库代理（DeepSeek + Cloudflare Vectorize）

前端只调用本代理，**DeepSeek 密钥仅存于 Worker Secret，绝不进仓库、不下发浏览器**。

当前版本是「文钞全集知识库问答」：

- 一次性建库：抓取站点文章，切分段落，用 Workers AI `@cf/baai/bge-m3` 生成向量，写入 Vectorize。
- 用户提问：问题向量化后检索相关段落，再把资料交给 DeepSeek 据文回答。
- 返回格式：`{ reply, cite, sources }`，其中 `sources` 会在前端展示为可点击出处。
- KV `RL` 同时用于每日限流和相同问题的短期答案缓存。

## 部署步骤

```bash
cd workers/ai-proxy
npx wrangler login

# 已有可跳过：限流 + 答案缓存 KV
npx wrangler kv namespace create RL

# 首次需要：文钞知识库向量索引
npx wrangler vectorize create wenchao-kb --dimensions=1024 --metric=cosine

# 密钥均交互输入，不写入任何文件
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put INDEX_SECRET

npx wrangler deploy
```

`wrangler.toml` 里已经绑定：

- `RL`：KV namespace
- `AI`：Workers AI
- `VEC`：Vectorize index `wenchao-kb`

若重新创建 KV 或 Vectorize，请把 Cloudflare 返回的 id/name 同步到 `wrangler.toml`。

## 建库

部署后分批调用 `/index`，每次返回 `cursor`，用下一次的 `cursor` 继续，直到 `done:true`。

```bash
curl -X POST "https://<worker>/index?cursor=0" \
  -H "X-Index-Secret: <INDEX_SECRET>"
```

不要把 `INDEX_SECRET` 放进 URL 参数，避免出现在浏览器历史、代理日志或命令分享里。

## 接通前端

把 Worker 地址填到 `site/config.js` 的 `aiEndpoint`，再部署站点。

## 安全须知

- 密钥若曾以明文出现（聊天/截图/日志），请到 DeepSeek 后台轮换后再 `secret put`。
- 代理已做：同源 CORS 白名单、每 IP 每日限流、答案缓存、检索资料约束、低温保真。
- 调优：`worker.js` 顶部常量可调 `TOP_K`、`ANSWER_CHARS`、`MAX_TOKENS`、`CACHE_TTL`、`DAILY_LIMIT`。
