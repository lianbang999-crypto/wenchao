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

  /* 安卓安装包（APK）下载地址，显示在「我的」页安装区。
     留空则不显示该行，只引导浏览器原生安装（PWA / 添加到主屏）。
     文件名带版本号，更新时换新文件并改此处，不会撞长缓存。
     日后若迁到对象存储，把这里换成完整 URL 即可，其余不动。 */
  apkUrl: '/app/wenchao-1.1.0.apk',

  /* 最新安装包版本号，与 app-android/app/build.gradle 的 versionName 保持一致。
     APP 内会拿自己的版本（启动地址带的 ?app=x.y.z）与此比对，
     落后才在「我的」页多显示一行「下载新版」。发新包时与 apkUrl 一起改。

     注意：1.1.0 起 APP 改为离线应用，内容随安装包出厂。经文勘误这类内容改动
     走 APP 内的增量更新（比对 /app/content-manifest.json），不必换包；
     只有阅读器本身改版才需要发新 APK、才靠这里的版本号提示。 */
  apkVersion: '1.1.0',
};
