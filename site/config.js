/* 站点配置（部署时按需修改） */
window.WENCHAO_CONFIG = {
  /* AI 助读后端代理地址（Cloudflare Worker），留空则前端显示"待接入"提示。
     约定：POST { articleId, title, messages } → { reply, cite }
     代理端须注入价值观约束的 system prompt：忠于印光大师原文、
     引用须标出处、不扮演佛菩萨口吻、不确定时建议查阅原文。 */
  aiEndpoint: '',

  /* 分享卡二维码/链接的站点基址（线上正式域名）。留空则取当前页面地址。 */
  shareBase: 'https://wenchao.foyue.org',

  /* 分享所选文字的字数上限（全角字）。超出截取并加省略号。 */
  shareMaxChars: 800,
};
