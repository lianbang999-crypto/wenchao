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
- `scripts/build_search.py`：生成 `site/data/search.json`
- `scripts/verify_alignment.py`：校验原文与 JSON 对齐

## AI 知识库

Cloudflare Worker 位于 `workers/ai-proxy/`，使用 Workers AI 生成 embedding、Vectorize 存储向量、KV 做限流与答案缓存。当前优化版知识库写入 Vectorize namespace `v2`；旧默认 namespace 保留作线上回退。

首次或重建 `v2` 前，先创建 metadata index：

```bash
npx wrangler vectorize create-metadata-index wenchao-kb --propertyName aid --type string
npx wrangler vectorize create-metadata-index wenchao-kb --propertyName vol --type string
npx wrangler vectorize create-metadata-index wenchao-kb --propertyName sourceType --type string
```

部署 Worker：

```bash
npx wrangler deploy --config workers/ai-proxy/wrangler.toml
```

建库接口需要 `INDEX_SECRET`，分批循环调用 `/index?cursor=...`，直到返回 `done:true`；遇到大批次触发 CPU 限制时，可临时加 `limit=5` 降低每次处理篇数。每个向量块会保存 `aid`、`title`、`vol`、`sourceType`、`pIndex`、`url`、`origKey` 和摘录文本，用于 NotebookLM 式检索、引用和段落跳转。
