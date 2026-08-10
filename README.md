# 印光法师文钞 · 文白对照

这是一个静态阅读站点，项目别名 `wenchao` / `yinguangfashiwenchao`，站点入口在 `site/index.html`，部署产物目录为 `site/`。

## 本地预览

```bash
python3 -m http.server 4173 --directory site
```

然后访问 `http://localhost:4173`。

## Cloudflare Pages 部署

项目已配置 `wrangler.jsonc`，Pages 输出目录为 `./site`。当前线上站点是已存在的
Cloudflare Pages Direct Upload 项目 `wenchao`，生产地址为 `https://wenchao.pages.dev/`。

```bash
npx wrangler login
npx wrangler pages deploy site --project-name=wenchao
```

`main` 分支已配置 GitHub Actions 自动部署到这个现有项目。仓库需要配置以下 GitHub
Actions Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

不要再在 Cloudflare Dashboard 中用 GitHub 连接新建另一个 `wenchao` Pages 项目；否则每次
push 会同时触发 GitHub Actions 和 Cloudflare Git Integration 两套部署。若以后决定迁移到
Cloudflare Git Integration，先停用 `.github/workflows/deploy-cloudflare-pages.yml`，再新建并
切换 Pages 项目。

手动部署仍可使用上面的 `wrangler pages deploy` 命令。

## 数据生成

- `scripts/parse_v2.py`：从文档提取实验模型数据到 `build/`
- `scripts/migrate_v2.py`：将 `build/` 数据迁移到 `site/data/`
- `scripts/verify_alignment.py`：校验原文与 JSON 对齐

站内「全文搜索」不再打包整站语料下发浏览器：篇名匹配走前端已加载的 `books.json` 本地过滤，
正文匹配调用 `workers/ai-proxy` 的 `POST /api/ai/search`，复用 AI 知识库已建的 D1 全文索引（见下）。

## 字体

`site/font/` 与 `site/css/fonts.css` 由 `scripts/build_font_subset.py` 生成，**不要手改**。
它按站内语料把 Noto Serif SC（可变，400–900）与霞鹜文楷 GB Screen 子集化，再按词频分层切片：
头片 1000 字覆盖语料 92.5%，尾片每 250 字一档；繁体（OpenCC cn→tw）排在简体之后自成连续块，
简体读者不会连带下载繁体分片。另含 GB2312 全字表兜底，AI 回答与搜索输入不掉字。

早先是原样镜像上游切片（每 192 字一片、按码位顺序），与中文行文用字完全不匹配——
实测单篇文章要拉 106 个切片共 4.65MB；改用本方案后同一篇是 13 片 1.62MB，`fonts.css` 从 496KB 降到 131KB。

只有语料字集变了（增删篇目）才需重跑：

```bash
python3 -m venv .venv && .venv/bin/pip install fonttools brotli
.venv/bin/python scripts/build_font_subset.py
```

源字体（各约 25MB）自动下载并缓存到 `.fontsrc/`（已 gitignore）。跑完记得升 `site/index.html`
的资源版本串并重跑 `build_article_pages.py`——`/css/*`、`/font/*` 都是 immutable 长缓存。

## AI 知识库

Cloudflare Worker 位于 `workers/ai-proxy/`，使用 Workers AI 生成 embedding、Vectorize 存储向量、D1 存全文(关键词)索引、KV 做限流与答案缓存。当前优化版知识库写入 Vectorize namespace `v2`；旧默认 namespace 保留作线上回退。

检索链路为「多查询+关键词抽取 → 混合召回（向量 + D1 全文 bigram 关键词）→ RRF 融合 → 去重 → 交叉编码器重排序（`@cf/baai/bge-reranker-base`）→ 小块检索大块喂入 → DeepSeek 据文作答标出处」，以提升回答准确度；混合检索/重排序/父段落全程 best-effort，缺 D1 或异常自动退回纯向量。细节与可调常量见 `workers/ai-proxy/README.md`。改动检索逻辑后用 `scripts/eval_rag.py` 跑召回率/引用率/拒答率回归，把准确性量化对比。

首次或重建前，先创建 Vectorize metadata index 与 D1 全文库：

```bash
npx wrangler vectorize create-metadata-index wenchao-kb --propertyName aid --type string
npx wrangler vectorize create-metadata-index wenchao-kb --propertyName vol --type string
npx wrangler vectorize create-metadata-index wenchao-kb --propertyName sourceType --type string

# 混合检索的全文(关键词)索引；建后把 database_id 填进 workers/ai-proxy/wrangler.toml 的 DB 绑定
npx wrangler d1 create wenchao-kb-fts
```

部署 Worker：

```bash
npx wrangler deploy --config workers/ai-proxy/wrangler.toml
```

建库接口需要 `INDEX_SECRET`，**从 `cursor=0` 起**分批循环调用 `/index?cursor=...`，直到返回 `done:true`（同一次会同时写向量库与 D1 全文索引，且 `cursor=0` 时整库重建全文表，故务必从头顺序跑）；遇到大批次触发 CPU 限制时，可临时加 `limit=5` 降低每次处理篇数。每个向量块会保存 `aid`、`title`、`vol`、`sourceType`、`pIndex`、`url`、`origKey`、`ctx`（父段落，供大块喂入）和摘录文本，用于 NotebookLM 式混合检索、引用和段落跳转。
