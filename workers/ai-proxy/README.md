# AI 助读知识库代理（DeepSeek + Cloudflare Vectorize）

前端只调用本代理，**DeepSeek 密钥仅存于 Worker Secret，绝不进仓库、不下发浏览器**。

当前版本是「文钞全集知识库问答」：

- 一次性建库：抓取站点文章，切分段落，用 Workers AI `@cf/baai/bge-m3` 生成向量，写入 Vectorize。
- 用户提问的检索链路（决定回答准确度）：
  1. **多查询 + 关键词抽取**：一次 DeepSeek 调用同时产出「文言改写检索式」（供向量召回）与「2~5 个关键名相」（供全文召回）；失败时退回原问 + 启发式关键词（`USE_QUERY_REWRITE`、`buildRetrieval`）。
  2. **混合召回（向量 + 全文）**：向量召回（bge-m3 + 多查询并集）与 **D1 FTS5 全文关键词召回** 并行；中文用「重叠二元(bigram)」分词索引，连「戒杀」这类 2 字名相也能精确命中（`USE_HYBRID`、`LEX_TOPK`）。
  3. **RRF 融合**：两路按各自名次用倒数排名融合成一个排序（`RRF_K`）；未开混合或关键词无命中时即纯向量序。
  4. **去重**：精选读本与文钞重出的近似段只保留一条，得到候选池（`RERANK_POOL`）。
  5. **交叉编码器重排序**：用 `@cf/baai/bge-reranker-base` 按真实相关度重排候选，再取 `TOP_K` 段（`USE_RERANK`）。这一步对精度提升最直接；任何异常都会自动退回纯向量序，不影响可用性。
  6. **小块检索、大块喂入**：命中的是精确小块，但喂给 DeepSeek 的是该小块所在的「父段落」（`PARENT_CHARS`），避免长句被切块截断、利于综合；引用卡片仍用精确小块，便于核对与高亮。
  7. 把最相关段交给 DeepSeek，据文作答、逐点标 `[n]` 出处。

> 混合检索、关键词抽取、重排序、父段落全程 **best-effort**：D1 未绑定/未建库、关键词抽取失败、FTS 查询异常等，都会自动退回纯向量召回，问答始终可用。
- 生成层（提升「智能/可信」）：
  1. **多轮追问改写（condense）**：多轮时先把含指代/省略的末句改写成可独立检索的完整问题（`USE_CONDENSE`、`condenseQuestion`），失败退回原启发式拼接。
  2. **接地 prompt + 编号范围约束**：系统提示告知「资料共 N 条，编号 1–N，不得越界引用」，逼模型据文作答、逐字直引。
  3. **引用逐字自检**：回答流完后纯字符串校验 `[n]` 是否越界、直引是否能在「模型实际看到的父段落」里逐字找到，结果随 `done` 事件以 `verify`（`{cited,invalid,quoteChecked,quoteOk,faithful}`）返回，作接地忠实度遥测（不改写已输出内容）。`scripts/eval_rag.py` 会汇总成「忠实率/直引逐字命中率」。
  4. **难题路由（默认关）**：`USE_REASONER_FOR_HARD=true` 时，比较/辨析类长问改用 `deepseek-reasoner`（更强综合，更慢更贵；推理 token 不外显）。
- 返回格式：ndjson 流（`meta` 携带 `passages`/`sources`/`cite`，`delta` 逐字，`done` 收尾并带 `verify`）。
- KV `RL` 同时用于每日限流和相同问题的短期答案缓存。改动检索逻辑后请同步抬高 `RETRIEVAL_VERSION`，让旧缓存失效、不遮蔽新结果。

## 部署步骤

```bash
cd workers/ai-proxy
npx wrangler login

# 已有可跳过：限流 + 答案缓存 KV
npx wrangler kv namespace create RL

# 首次需要：文钞知识库向量索引
npx wrangler vectorize create wenchao-kb --dimensions=1024 --metric=cosine

# 首次需要：混合检索的全文(关键词)索引（D1）。把返回的 database_id 填进 wrangler.toml
npx wrangler d1 create wenchao-kb-fts

# 密钥均交互输入，不写入任何文件
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put INDEX_SECRET

npx wrangler deploy
```

`wrangler.toml` 里已经绑定：

- `RL`：KV namespace（限流 + 答案缓存）
- `AI`：Workers AI（向量 + 重排序）
- `VEC`：Vectorize index `wenchao-kb`（向量库）
- `DB`：D1 `wenchao-kb-fts`（混合检索的全文/关键词索引；缺它则自动退回纯向量）

若重新创建 KV / Vectorize / D1，请把 Cloudflare 返回的 id/name 同步到 `wrangler.toml`。

## 建库

部署后分批调用 `/index`，每次返回 `cursor`，用下一次的 `cursor` 继续，直到 `done:true`。同一次调用会**同时**写入向量库与 D1 全文索引。

```bash
curl -X POST "https://<worker>/index?cursor=0" \
  -H "X-Index-Secret: <INDEX_SECRET>"
```

- **务必从 `cursor=0` 开始顺序跑到 `done:true`**：FTS5 全文表在 `cursor=0` 时整库 DROP+CREATE 重建，中途插入会导致全文索引不完整。
- 响应里的 `d1:true` 表示 D1 绑定可用、`lexIndexed` 为该批写入全文索引的段数。
- 不要把 `INDEX_SECRET` 放进 URL 参数，避免出现在浏览器历史、代理日志或命令分享里。
- 改了切块/父段落/分词逻辑（`worker.js`）后需重建一次，让 `ctx`、bigram 全文索引同步更新。

## 接通前端

把 Worker 地址填到 `site/config.js` 的 `aiEndpoint`，再部署站点。

## 对外开放：API key 鉴权 + 按 key 配额

问答接口 `POST /api/ai` 支持三类调用来源，分流鉴权（`worker.js` 的 `authenticate`/`enforceQuota`）：

1. **带 API key**（第三方 / 服务端）：请求头 `Authorization: Bearer <key>` 或 `X-Api-Key: <key>`。校验通过后按**该 key 独立的每日配额**计数（默认 `KEY_DAILY_LIMIT`，可在密钥表里给某 key 单独写 `limit`），不与他人共享 IP 限额。
2. **无 key 但来自白名单 `Origin`/`Referer`**（自家网页）：沿用**每 IP 每日 `DAILY_LIMIT`** 限额，行为不变。
3. **既无 key 又非自家网页**：`REQUIRE_KEY_FOR_API=true`（默认）时返回 `401`，把匿名 `curl` 直调挡在门外；置 `false` 则退回②的匿名路径（仅受 IP 限额）。

> `Origin`/`Referer` 可被伪造，仅用于「是不是自家前端」的软判断；真正的鉴权靠 API key。浏览器里放不住真密钥，所以**网页前端始终走②的匿名+IP 限额路径**，这是公开网站后端的固有约束——API key 是给服务端/第三方用的。

**签发 / 停用 key**（用 `scripts/api_keys.sh`，维护本地主表 `workers/ai-proxy/.api_keys.json`，已 gitignore；Worker Secret 写后不可读回，本地主表是唯一真相来源）：

```bash
bash scripts/api_keys.sh new 伙伴A 1000   # 生成 key + 每日额度，打印明文(仅此一次)
bash scripts/api_keys.sh list             # 查看（不显明文）
bash scripts/api_keys.sh revoke 伙伴A      # 停用
bash scripts/api_keys.sh push             # 写入 Worker Secret API_KEYS，即时生效
```

第三方调用示例：

```bash
curl -X POST https://wenchao.foyue.org/api/ai \
  -H "Authorization: Bearer <明文key>" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"念佛如何摄心？"}]}'
```

返回与网页一致：`application/x-ndjson` 流（`meta`/`delta`/`done`）。`GET /api/ai/health` 会回报 `apiKeyAuth`（是否已配置密钥表）、`apiKeys`（已配 key 数）、`requireKey`、`keyDailyLimit`，便于确认生效。

## 安全须知

- 密钥若曾以明文出现（聊天/截图/日志），请到 DeepSeek 后台轮换后再 `secret put`。
- 代理已做：同源 CORS 白名单、API key 鉴权 + 按 key 配额、每 IP 每日限流、答案缓存、检索资料约束、低温保真。
- 调优：`worker.js` 顶部常量可调 `TOP_K`、`RERANK_POOL`、`USE_RERANK`、`USE_QUERY_REWRITE`、`USE_HYBRID`、`LEX_TOPK`、`RRF_K`、`PARENT_CHARS`、`USE_CONDENSE`、`USE_REASONER_FOR_HARD`、`ANSWER_CHARS`、`MAX_TOKENS`、`CACHE_TTL`、`DAILY_LIMIT`、`REQUIRE_KEY_FOR_API`、`KEY_DAILY_LIMIT`。
- 自检：部署后 `GET /api/ai/health` 会回报当前 `rerank`、`queryRewrite`、`condense`、`reasonerForHard`、`hybrid`、`hybridReady`（D1 全文索引是否就绪）、`lexRows`（已建全文索引行数）、`parentChars`、`retrievalVersion`、`vectors`（已建向量数）等，便于确认配置生效。

## 评测准确度（改检索逻辑后必跑）

`scripts/eval_rag.py` 会对线上端点逐题发问，统计**召回率**（命中应引用的篇目）、**引用率**、**拒答率**，以及**接地忠实度**（读 `done.verify`：忠实率、直引逐字命中率、是否出现越界编号），把「准确性 + 可信度」变成可量化的数字：

```bash
python3 scripts/eval_rag.py --endpoint https://wenchao.foyue.org/api/ai --out scripts/eval_result.json
```

题集在 `scripts/eval_questions.json`，请按义理补全各题的 `expectArticles`（应被引用的篇目 id，见 `site/data/books.json`），标注越全，召回率越可信。每次调整 `worker.js` 检索参数后重跑对比升降即可。注意线上每 IP 每日限流，题量大时分次跑或本地 `wrangler dev` 评测。
