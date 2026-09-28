# 印光文钞 · Android APP（离线阅读应用）

自建 WebView 应用：**全部经文随安装包装进手机，断网也能读**。
网络只在两处用到——检查更新、下载新版；正文阅读全程不联网。

## 为什么不再是 TWA

1.0.4 及之前是 bubblewrap 生成的 TWA 外壳，本质是「委托 Chrome 打开
`wenchao.foyue.org`」。包里一篇经文都没有（2.5MB），每次打开都要联网现取 81MB 的站点。
站点在 Cloudflare 上，国内网络一波动就打不开；而 TWA 全屏无地址栏，用户连刷新都点不着，
看到的就是「装了却打不开」。

TWA 架构上没法带本地内容，所以 1.1.0 换成自建 WebView：

| | 1.0.4（TWA） | 1.1.0（离线） |
|---|---|---|
| 包体 | 2.5 MB | 20 MB |
| 经文 | 0 篇，全靠联网 | 2565 篇随包出厂 |
| 断网 | 打不开 | 照常读 |
| 渲染 | Chrome / 系统 WebView | 系统 WebView |
| 内容更新 | 站点改了即最新 | APP 内增量下载 |

包名 `org.foyue.wenchao`（**发布后永不可改**）· minSdk 21 · 签名与 1.0.4 一致，老用户可直接覆盖安装。

## 构建

```bash
# 1. 先把站点内容同步进 assets —— 漏了这步，装出来是个没有经文的空壳
python3 scripts/build_app_assets.py

# 2. 打包
cd app-android
./gradlew :app:assembleRelease

# 3. 签名
export PATH="$PATH:$ANDROID_HOME/build-tools/34.0.0"
KP=$(grep '^密码' keystore/KEYSTORE-INFO.txt | awk '{print $2}')
apksigner sign --ks keystore/wenchao-upload.keystore --ks-key-alias wenchao \
  --ks-pass "pass:$KP" --key-pass "pass:$KP" \
  --out wenchao-<版本>.apk app/build/outputs/apk/release/app-release-unsigned.apk

# 4. 发布：APK 拷进 site/app/，同步改 site/config.js 的 apkUrl 与 apkVersion
```

发新版：改 `app/build.gradle` 的 `versionCode`（+1）与 `versionName`，重走上面四步。

## 代码结构

| 文件 | 职责 |
|---|---|
| `MainActivity.java` | WebView 配置、AssetLoader 挂载、外链外跳、返回键、内核过旧的提示页 |
| `AppContentHandler.java` | 内容取件：覆盖层 → 出厂内容 → SPA 回退三级查找，MIME 判定 |
| `ContentUpdater.java` | 内容增量更新：比对清单、下载变动篇目、原子落盘 |
| `NativeBridge.java` | 暴露给页面的 `window.__wcNative`：查更新、装新包、网络状态 |
| `scripts/build_app_assets.py` | 从 `site/` 挑出 APP 要用的部分同步进 assets，生成内容清单 |

内容挂在 `https://appassets.androidplatform.net` 这个本地域下（不走网络），
而非 `file://`——后者受同源策略限制，localStorage 与 fetch 都会失效，
挂在 https 域下则与线上环境一致，站点代码不必为 APP 改写。

`assets/` 是构建产物（27MB、2700+ 文件），已 gitignore，源头在 `site/`。

## 两条更新线

**内容线（增量，不必重装）**
经文勘误、白话修订这类改动，只涉及个别篇目。APP 拉
`https://wenchao.foyue.org/app/content-manifest.json` 比对每篇摘要，
只下有变动的（一篇约 8KB），写进 `filesDir/content/` 作为覆盖层，
下次取数自动优先用新版。出厂内容始终留底，覆盖层删掉即复原。

发布内容更新：改完 `site/data/`，跑一次 `build_app_assets.py`
（它会重新生成 `site/app/content-manifest.json`），把站点部署上去即可。
**不需要发新 APK。**

**外壳线（换包）**
阅读器本身改版才需要。站点 `config.js` 的 `apkVersion` 一改，
APP 在「我的」页比对出落后就提示下载安装。

## ⚠️ 签名密钥（keystore/ 目录，已 gitignore）

`keystore/wenchao-upload.keystore` + `KEYSTORE-INFO.txt`（含密码）。

**丢失 = 这个 APP 永远无法再更新**，只能换包名重新上架、已装用户全部流失。
立即备份到至少两处（密码管理器 + 加密网盘）。密码与文件分开存。

指纹：`E6:09:86:0C:AE:98:35:78:4E:B4:93:38:00:15:E8:5B:1E:90:C4:43:9E:C2:3C:2E:23:65:37:2F:C1:AF:2A:97`

## WebView 缺失的 Web 能力（踩过的坑，别再当浏览器写）

自建 WebView 与 Chrome 不是一回事，下面这些在 TWA 时代能用、换过来就断了。
新增功能前先对照一遍，别等用户报上来：

| 能力 | WebView 里的实情 | 本项目的做法 |
|---|---|---|
| `speechSynthesis` | **API 在但是空壳**：`in window` 为真，getVoices() 空、speak() 无声、onend 不回调 | 走原生 `TextToSpeech`（NativeBridge.ttsSpeak） |
| `<a download>` | 不触发下载（除非另装 DownloadListener） | 走原生存相册（NativeBridge.saveImage） |
| `navigator.share` | 不存在 | 走原生 `ACTION_SEND`（NativeBridge.shareImage） |
| 长按图片菜单 | 没有「保存/分享」上下文菜单 | 同上，界面上补显式按钮 |
| `alert/confirm` | **不装 WebChromeClient 就静默丢弃**，不报错也不显示 | MainActivity 已装默认 WebChromeClient |
| 跨域请求 | 页面 origin 是 `appassets.androidplatform.net`，打后端即跨域 | Worker 的 ALLOW_ORIGINS 已加该域 |

判断「我在 APP 里吗」统一用 `window.__wcNative` 是否存在，不要靠 UA 或 display-mode
（WebView 的 `display-mode: standalone` 并不成立）。

## 关于旧 WebView

阅读器入口是 `<script type="module">`，要 Chrome 61 起才认。
国产手机没有 Google Play，系统 WebView 可能停在很旧的版本，届时脚本整份解析失败、
页面一动不动。`MainActivity` 会先查内核版本，低于 61 时给一页说明
（引导去应用商店更新 WebView），而不是让人对着白屏猜。

站点代码本身已把兼容下限压到 Chrome 61：`??`、无参 `catch {}`、`.finally()`
这些更高版本才有的写法都已改掉。再往下就要动模块入口了，代价过大。

## assetlinks.json

`site/.well-known/assetlinks.json` 原是 TWA 用来去掉地址栏的凭据。
离线应用不再需要它，但**先别删**——已装 1.0.4 的用户升级前仍在走 TWA 路径。
等这批用户基本升上来，再考虑清理。

## Google Play 上架清单（个人开发者账号）

1. **先想清楚**：个人账号的真实姓名+地址会公开显示在商店页（强制）
2. 注册 Play Console（$25 一次性）→ 身份验证
3. 创建应用 → 上传 AAB（`./gradlew :app:bundleRelease`）→ **开启 Play App Signing**
4. 商店资料：名称「印光法师文钞」、简介、截图（手机 2+ 张）、512 图标（工程里 `store_icon.png`）、置于「图书与工具书」类
5. **数据安全表单如实填**：
   - 「问文钞」AI 问答会把用户提问发给第三方模型服务（DeepSeek 经自有 Worker 代理）→ 申报「收集用户生成内容 / 不与身份关联 / 用于应用功能」
   - 收藏/划线/进度存本地 localStorage，不上传
6. 隐私政策：需一个公开 URL（建议 `wenchao.foyue.org/privacy/`，内容照第 5 条如实写）
7. 内容分级问卷 → 宗教内容如实选
8. 新个人账号首次发生产版本前需**封闭测试**（人数/天数以 Console 实时提示为准）— 组织账号免此项

## 官网 APK 分发注意

- 下载页要附「安装未知应用」引导（各国产 ROM 会拦）
- 每次发新 APK 记得同步改 `site/config.js` 的 `apkUrl` 与 `apkVersion`
- 20MB 的包，下载页最好标明体积与「装完即可离线阅读」，让人知道这 20MB 换来了什么
