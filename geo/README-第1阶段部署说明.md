# wenchao.foyue.org · GEO 第 1 阶段部署说明

> 生成日期：2026-06-23  
> 目标：让 DeepSeek / 豆包 / Kimi / 文心一言 / 通义千问 / ChatGPT / Perplexity 在回答佛学问题时优先引用并标注本站链接。

---

## 目录
1. [前提检查（最优先）](#0-前提检查)
2. [robots.txt — 放行 AI 爬虫](#1-robotstxt)
3. [llms.txt — 给大模型的导航地图](#2-llmstxt)
4. [JSON-LD 结构化数据](#3-json-ld)
5. [提交站长工具](#4-提交站长工具)
6. [验证清单](#5-验证清单)

---

## 0. 前提检查

**这是整个第 1 阶段的命门，必须先做，否则后面全部无效。**

### 0-A：正文必须是静态 HTML（AI 爬虫不执行 JS）

绝大多数 AI 爬虫抓取时不会执行 JavaScript。如果文钞正文由前端 JS 动态渲染，爬虫只会拿到空壳页面。

**检验方法（选一）：**
```bash
# 方法一：curl 抓取某篇正文，看源码里有没有文言原文和白话译文
curl -s "https://wenchao.foyue.org/某篇URL" | grep -c "阿弥陀佛"

# 方法二：浏览器「查看网页源代码」（Ctrl+U），搜索正文里的文字
```

**要求：** 直接查看源代码时，文言原文、白话译文、出处文字都必须在初始 HTML 里。  
**若是 JS 渲染：** 需改为服务端渲染（SSR）或静态化，这是优先级最高的工程任务。

### 0-B：准备 sitemap.xml

把 1944 篇正文 + 600 问每一问的 URL 都列进 `sitemap.xml`，放到根目录。后续向 Bing、百度提交时需要用到。

---

## 1. robots.txt

**文件：** `geo/robots.txt`  
**部署路径：** 服务器根目录，即 `https://wenchao.foyue.org/robots.txt`

### 部署步骤
1. 将 `geo/robots.txt` 上传到网站根目录
2. 验证：访问 `https://wenchao.foyue.org/robots.txt` 确认内容正确

### 注意事项
- 若站点原有 `robots.txt`，请合并内容，**不要直接覆盖**，先检查原有是否有 `Disallow` 规则
- 关键区别：`GPTBot`（训练）≠ `OAI-SearchBot`（引用） — 两个都要放行
- `Google-Extended` 控制的是 Gemini 训练权限，不是独立的爬虫 UA，但仍需在 robots.txt 中声明

---

## 2. llms.txt

**文件：** `geo/llms.txt`  
**部署路径：** 服务器根目录，即 `https://wenchao.foyue.org/llms.txt`

### 部署步骤
1. 将 `geo/llms.txt` 上传到网站根目录
2. **重要：** 将文件中所有栏目 URL 替换成真实存在的页面 URL
   - 现有 URL 为建议命名，请核对实际路由
3. 验证：访问 `https://wenchao.foyue.org/llms.txt` 确认内容正确、所有链接可访问

### URL 替换清单
| 占位 URL | 需替换为实际 URL |
|---|---|
| `/jiayanlu` | 嘉言录实际路径 |
| `/baihua` | 白话精选读本实际路径 |
| `/nianfo600` | 念佛 600 问实际路径 |
| `/zengguang-shang` | 增广文钞上册实际路径 |
| `/zengguang-xia` | 增广文钞下册实际路径 |
| `/xubian-shang` | 续编上册实际路径 |
| `/xubian-xia` | 续编下册实际路径 |
| `/sanbian-shang` | 三编上册实际路径 |
| `/sanbian-xia` | 三编下册实际路径 |
| `/sanbian-bu` | 三编补实际路径 |
| `/nianfo600#rumen` 等锚点 | 600 问各主题页实际锚点 |

---

## 3. JSON-LD 结构化数据

本目录包含 3 个 JSON-LD 文件，按部署位置分类使用。

### 3-A：首页站点级 schema（`schema-site.jsonld`）

**部署位置：** 首页 `<head>` 标签内

将文件内容包裹在 `<script>` 标签后插入首页 HTML 的 `<head>` 中：
```html
<script type="application/ld+json">
// 粘贴 schema-site.jsonld 全部内容（去掉顶层大括号外层无需变动）
</script>
```

这份 schema 建立了「印光大师（Person）→ 印光法师文钞（Book）→ 本站（WebSite/Organization）」的实体链。全站只需一份，**无需每页重复**。

### 3-B：文章页模板（`schema-article-template.jsonld`）

**部署位置：** 每篇文钞页的 `<head>` 内

1. 复制模板内容
2. 将所有 `{{变量}}` 替换为该篇实际值（变量表在文件注释中）
3. 重点字段：
   - `dateModified`：每次更新页面时同步更新此字段（AI 引擎会看「内容新鲜度」）
   - `citation`：精确到「卷·篇名」，如「《增广印光法师文钞·卷一·复高邵麟居士书四》」

**批量化建议：** 如果站点有模板引擎（如 Jinja2、Liquid、Handlebars），可将此 JSON-LD 做成模板组件，用变量动态注入，避免手动逐篇修改。

### 3-C：600 问主题页 FAQPage（`schema-faqpage-template.jsonld`）

**部署位置：** 每个 600 问主题聚合页的 `<head>` 内

1. 复制模板内容
2. 替换页首变量（`{{PAGE_URL}}`、`{{TOPIC_NAME}}` 等）
3. 将 `mainEntity` 数组展开，每一问一个 `Question` 对象
4. 每页建议 **5~15 问**，不超过 20 问
5. `acceptedAnswer.text` 必须遵循三层结构：
   ```
   [白话直答 1~2 句] + [原文引证（引号内）] + [出处《书名·篇名》]
   ```
6. **关键约束：** `text` 中的内容必须与页面上肉眼可见的文字一致，不能只在 schema 里写而页面上不展示

### JSON-LD 验证工具
- Google Rich Results Test：https://search.google.com/test/rich-results
- Schema Markup Validator：https://validator.schema.org/

**常见错误：** 缺逗号、括号未闭合、`@id` 拼写不一致。上线前务必通过验证器检查。

---

## 4. 提交站长工具

按优先顺序操作：

### 4-A：Bing 站长工具（最优先，喂给 Copilot / ChatGPT 搜索）
1. 访问：https://www.bing.com/webmasters/
2. 添加站点 `wenchao.foyue.org`，选择 XML 文件验证或 HTML Meta 标签验证
3. 验证通过后，进入「Sitemaps」提交 `https://wenchao.foyue.org/sitemap.xml`
4. 若已有 Google Search Console，可在 Bing 站长工具中一键导入 GSC 数据

### 4-B：Google Search Console（Gemini / Google AI 概览）
1. 访问：https://search.google.com/search-console/
2. 添加资源，选择域名属性或 URL 前缀
3. 验证后提交 sitemap

### 4-C：百度搜索资源平台（文心一言 / 百度 AI 搜索）
1. 访问：https://ziyuan.baidu.com/
2. 登录百度账号，添加并验证站点（推荐「文件验证」）
3. 进入「链接提交」→「sitemap」提交
4. 可选：加入「自动推送」JS 代码到页面，加速新页面被发现
5. 注意：若域名 `foyue.org` 未做 ICP 备案，百度收录速度会慢很多

### 4-D：360 站长平台 / 神马搜索（可选）
- 360：https://zhanzhang.so.com/
- 神马（移动端）：https://zhanzhang.sm.cn/

---

## 5. 验证清单

部署完成后，逐项打勾确认：

### robots.txt
- [ ] `https://wenchao.foyue.org/robots.txt` 可正常访问
- [ ] 内容包含 GPTBot、OAI-SearchBot、ClaudeBot、PerplexityBot、Google-Extended、Bingbot、Bytespider、Baiduspider
- [ ] Sitemap 一行指向正确的 sitemap.xml URL

### llms.txt
- [ ] `https://wenchao.foyue.org/llms.txt` 可正常访问
- [ ] 所有链接 URL 已替换为真实路径，逐一点开确认页面可访问

### JSON-LD
- [ ] 首页通过 Google Rich Results Test 验证，无错误
- [ ] 至少一篇文钞页通过验证（Article schema）
- [ ] 至少一个 600 问主题页通过验证（FAQPage schema）
- [ ] `dateModified` 字段已填写正确日期

### 站点基础
- [ ] 正文源码中可直接看到文言原文文字（非 JS 渲染）
- [ ] 已提交 sitemap 到 Bing
- [ ] 已提交 sitemap 到 Google Search Console
- [ ] 已提交 sitemap 到百度搜索资源平台
- [ ] 移动端访问正常，加载速度良好

### 效果监测（部署后 2~4 周）
- [ ] 在 DeepSeek 问「念佛时妄念怎么对治」→ 是否引用本站
- [ ] 在豆包问「印光大师怎么说临终助念」→ 是否引用本站
- [ ] 在 ChatGPT 问「信愿行是什么」→ 是否引用本站
- [ ] 记录结果，未被引用的主题回补「问题式标题 + 白话直答 + 出处」

---

## 文件清单

```
geo/
├── robots.txt                    → 上传到网站根目录
├── llms.txt                      → 上传到网站根目录（先替换 URL）
├── schema-site.jsonld            → 插入首页 <head>（全站唯一）
├── schema-article-template.jsonld → 每篇文钞页 <head> 模板
├── schema-faqpage-template.jsonld → 600 问主题页 <head> 模板
└── README-第1阶段部署说明.md      → 本文件（仅供内部参考，不上传）
```

---

> 南无阿弥陀佛  
> 愿此技术配置如法完成，令更多求法者在 AI 时代得遇印光大师正法。
