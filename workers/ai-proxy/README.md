# AI 助读代理（DeepSeek）

前端只调用本代理，**DeepSeek 密钥仅存于 Worker Secret，绝不进仓库、不下发浏览器**。
代理取「本篇原文+白话」作依据，注入价值观约束，再转调 DeepSeek，返回 `{ reply, cite }`。

## 部署步骤

```bash
cd workers/ai-proxy
npx wrangler login              # 首次需登录 Cloudflare
npx wrangler deploy             # 部署，记下输出的 https://wenchao-ai.<子域>.workers.dev

# 设置密钥（交互输入，密钥不写入任何文件）
npx wrangler secret put DEEPSEEK_API_KEY

# （强烈建议）护额度限流：创建 KV，把返回的 id 填入 wrangler.toml 后重新 deploy
npx wrangler kv namespace create RL
# 取消 wrangler.toml 中 [[kv_namespaces]] 注释、填 id，再 npx wrangler deploy
```

## 接通前端

把上面 deploy 输出的 Worker 地址填到 `site/config.js` 的 `aiEndpoint`，再部署站点。

## 安全须知

- 密钥若曾以明文出现（聊天/截图/日志），请到 DeepSeek 后台**轮换**后再 `secret put`。
- 代理已做：同源 CORS 白名单、每 IP 每日限流（绑 KV 后生效）、低温保真、原文接地防臆造。
- 调优：`worker.js` 顶部常量可调 `MODEL`、`MAX_CTX_CHARS`、`DAILY_LIMIT`。
