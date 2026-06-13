# 印光法师文钞 · 文白对照

这是一个静态阅读站点，项目别名 `wenchao` / `yinguangfashiwenchao`，站点入口在 `site/index.html`，部署产物目录为 `site/`。

## 本地预览

```bash
python3 -m http.server 4173 --directory site
```

然后访问 `http://localhost:4173`。

## Cloudflare Pages 部署

项目已配置 `wrangler.jsonc`，Pages 输出目录为 `./site`。

```bash
npx wrangler login
npx wrangler pages deploy site --project-name=wenchao
```

`main` 分支已配置 GitHub Actions 自动部署到现有 Cloudflare Pages 项目 `wenchao`。
仓库需要配置以下 GitHub Actions Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

如果使用 GitHub 连接 Cloudflare Pages：

- Build command 留空
- Build output directory 填 `site`
- Root directory 留空

## 数据生成

- `scripts/parse_v2.py`：从文档提取实验模型数据到 `build/`
- `scripts/migrate_v2.py`：将 `build/` 数据迁移到 `site/data/`
- `scripts/build_search.py`：生成 `site/data/search.json`
- `scripts/verify_alignment.py`：校验原文与 JSON 对齐
