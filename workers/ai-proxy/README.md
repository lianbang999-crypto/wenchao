# AI 助读知识库代理（DeepSeek + Cloudflare Vectorize）

前端只调用本代理，**DeepSeek 密钥仅存于 Worker Secret，绝不进仓库、不下发浏览器**。

当前版本是「文钞全集知识库问答」：

- 一次性建库：抓取站点文章，切分段落，用 Workers AI `@cf/baai/bge-m3` 生成向量，写入 Vectorize。
- 用户提问的检索链路（决定回答准确度）：
  1. **多查询召回**：原问 +（可选）DeepSeek 把白话问题改写成贴近文钞文言的检索式，两路向量并取并集，提升召回（`USE_QUERY_REWRITE`）。
  2. **去重**：精选读本与文钞重出的近似段只保留一条，得到候选池（`RERANK_POOL`）。
  3. **交叉编码器重排序**：用 `@cf/baai/bge-reranker-base` 按真实相关度重排候选，再取 `TOP_K` 段（`USE_RERANK`）。这一步对精度提升最直接；任何异常都会自动退回纯向量序，不影响可用性。
  4. 把最相关段交给 DeepSeek，据文作答、逐点标 `[n]` 出处。
- 返回格式：ndjson 流（`meta` 携带 `passages`/`sources`/`cite`，随后 `delta` 逐字、`done` 收尾）。
- KV `RL` 同时用于每日限流和相同问题的短期答案缓存。改动检索逻辑后请同步抬高 `RETRIEVAL_VERSION`，让旧缓存失效、不遮蔽新结果。

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
- 调优：`worker.js` 顶部常量可调 `TOP_K`、`RERANK_POOL`、`USE_RERANK`、`USE_QUERY_REWRITE`、`ANSWER_CHARS`、`MAX_TOKENS`、`CACHE_TTL`、`DAILY_LIMIT`。
- 自检：部署后 `GET /api/ai/health` 会回报当前 `rerank`、`queryRewrite`、`retrievalVersion`、`vectors`（已建向量数）等，便于确认配置生效。

## 评测准确度（改检索逻辑后必跑）

`scripts/eval_rag.py` 会对线上端点逐题发问，统计**召回率**（命中应引用的篇目）、**引用率**、**拒答率**等，把「准确性」变成可量化的数字：

```bash
python3 scripts/eval_rag.py --endpoint https://wenchao.foyue.org/api/ai --out scripts/eval_result.json
```

题集在 `scripts/eval_questions.json`，请按义理补全各题的 `expectArticles`（应被引用的篇目 id，见 `site/data/books.json`），标注越全，召回率越可信。每次调整 `worker.js` 检索参数后重跑对比升降即可。注意线上每 IP 每日限流，题量大时分次跑或本地 `wrangler dev` 评测。
