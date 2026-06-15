/* 站点配置（部署时按需修改） */
window.WENCHAO_CONFIG = {
  /* AI 助读后端代理地址。代理代码在 workers/ai-proxy/（DeepSeek，密钥仅存于 Worker Secret）。
     部署 Worker 后，把此处改为它的地址，例如：
       'https://wenchao-ai.<你的子域>.workers.dev'
     （或为 Worker 配同源路由 wenchao.foyue.org/api/* 后填 '/api/ai'，免跨域）
     留空则前端显示"待接入"提示。约定：POST { articleId, title, messages } → { reply, cite }。 */
  aiEndpoint: '/api/ai',

  /* 分享卡二维码/链接的站点基址（线上正式域名）。留空则取当前页面地址。 */
  shareBase: 'https://wenchao.foyue.org',

  /* 分享所选文字的字数上限（全角字）。超出截取并加省略号。 */
  shareMaxChars: 800,
};
