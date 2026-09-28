# 印光文钞 · Android APP（离线阅读应用）

自建 WebView 应用：**全部经文随安装包装进手机，断网也能读**。
随包正文阅读全程不联网；AI 问答、联网搜索、云端语音和检查更新需要网络。

## 旧设备兼容模式

从 1.1.4（versionCode 10）起，最低安装版本为 **Android 4.4（API 19）**。这类设备启动时会进入随包提供的「基础阅读」页：2565 篇目录分页、篇名搜索、逐段文白对照、完整注释、前后篇、字号调整和阅读位置保存均可离线使用。

Android 5.0 以上且 WebView 主版本达到 61 的设备继续使用完整阅读器；旧内核或无法识别的内核使用基础阅读页。基础版不提供 AI、朗读、分享图片、书签备份与应用内更新，阅读数据保存在本机，与完整阅读器分别存储。没有白话的段落保留原文并明确提示。

Android 4.1–4.3 不能安装此版本。模拟器通过仍不能代表所有厂商的 Android 4.4 真机，正式分发前应在目标手机试装。

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

包名 `org.foyue.wenchao`（**发布后永不可改**）· minSdk 19 · 使用原发布密钥签名，保留 v1 签名以供 Android 4.4 安装。

## 构建

```bash
# 1. 先把站点内容同步进 assets —— 漏了这步，装出来是个没有经文的空壳
python3 scripts/build_app_assets.py --assets-only

# 2. 打包
cd app-android
./gradlew :app:assembleRelease :app:lintDebug

# 3. 签名
export PATH="$PATH:$ANDROID_HOME/build-tools/36.0.0"
# 按交互提示输入密钥密码，密码不放进命令参数或日志。
apksigner sign --ks keystore/wenchao-upload.keystore --ks-key-alias wenchao \
  --v1-signing-enabled true \
  --out wenchao-<版本>.apk app/build/outputs/apk/release/app-release-unsigned.apk

# 4. 检查：输出必须包含 Verified using v1 scheme: true 和预期签名指纹
apksigner verify --verbose --print-certs --min-sdk-version 19 wenchao-<版本>.apk
```

发新版：改 `app/build.gradle` 的 `versionCode`（+1）与 `versionName`，重走上面四步。构建测试完成后把签名 APK 放入 `site/app/`，更新 `site/config.js` 的版本与地址，并运行不带 `--assets-only` 的资产脚本生成线上更新清单，再部署 Pages。单个文件不能超过 Pages 的 25 MiB 上限；更大的包应改走 R2。仅构建测试包不等于已上线。

## 代码结构

| 文件 | 职责 |
|---|---|
| `MainActivity.java` | 按系统与内核选阅读器、AssetLoader 挂载、外链外跳、返回键 |
| `AppContentHandler.java` | 内容取件：覆盖层 → 出厂内容 → SPA 回退三级查找，MIME 判定 |
| `ContentUpdater.java` | 内容增量更新：比对清单、下载变动篇目、原子落盘 |
| `NativeBridge.java` | 暴露给页面的 `window.__wcNative`：查更新、装新包、网络状态 |
| `scripts/build_app_assets.py` | 从 `site/` 挑出 APP 要用的部分同步进 assets，生成内容清单 |
| `site/legacy.html`、`site/js/legacy.js`、`site/css/legacy.css` | 旧内核的 ES5 / XHR 基础阅读页 |

内容挂在 `https://appassets.androidplatform.net` 这个本地域下（不走网络），
而非 `file://`——后者受同源策略限制，localStorage 与 fetch 都会失效，
挂在 https 域下则与线上环境一致，站点代码不必为 APP 改写。

`assets/` 是构建产物（27MB、2700+ 文件），已 gitignore，源头在 `site/`。

## 两条更新线

**内容线（增量，不必重装）**
经文勘误、白话修订这类改动，只涉及个别篇目。APP 拉
`https://wenchao.foyue.org/app/content-manifest.json` 比对每篇摘要，
只下与出厂内容不同的资源，逐份校验摘要并写入独立暂存目录；全部成功后，
用 `content-state.json` 一次性切换生效目录。失败时仍读取上一版内容，
出厂内容始终留底。旧版本的 `filesDir/content/` 覆盖层可继续读取。

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
| `<a download>` | 不触发下载（除非另装 DownloadListener） | 分享卡调用原生保存：Android 10 及以上写相册，Android 4.4–9 由系统选取保存位置，无需存储权限 |
| `navigator.share` | 不存在 | 走原生 `ACTION_SEND`（NativeBridge.shareImage） |
| 长按图片菜单 | 没有「保存/分享」上下文菜单 | 同上，界面上补显式按钮 |
| `alert/confirm` | **不装 WebChromeClient 就静默丢弃**，不报错也不显示 | MainActivity 已装默认 WebChromeClient |
| 跨域请求 | 页面 origin 是 `appassets.androidplatform.net`，打后端即跨域 | Worker 的 ALLOW_ORIGINS 已加该域 |

判断「我在 APP 里吗」统一用 `window.__wcNative` 是否存在，不要靠 UA 或 display-mode
（WebView 的 `display-mode: standalone` 并不成立）。

## 关于旧 WebView

阅读器入口是 `<script type="module">`，要 Chrome 61 起才认。
国产手机没有 Google Play，系统 WebView 可能停在很旧的版本，届时脚本整份解析失败、
页面一动不动。`MainActivity` 先查实际 WebView 的 UA，再尝试系统组件包版本。
Android 4.4、低于 61 或无法识别的内核进入 `legacy.html`，不加载现代脚本。

站点代码本身已把兼容下限压到 Chrome 61：`??`、无参 `catch {}`、`.finally()`
这些更高版本才有的写法都已改掉。基础版使用独立的 ES5 / XHR 入口，不依赖模块、
fetch、Promise、Service Worker、CSS 变量或在线字体。

## 兼容性回归

```bash
node --test scripts/legacy-reader.test.mjs
cd app-android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
# 指定专用模拟器序列号，避免安装到个人手机。
adb -s <序列号> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <序列号> install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s <序列号> shell am instrument -w -r org.foyue.wenchao.test/org.foyue.wenchao.CompatibilitySmokeTest
```

自定义 runner 在实际 WebView 中操作目录和正文。成功须同时出现 `ok=true` 与
`INSTRUMENTATION_CODE: 0`；不要仅根据 `adb` 的 shell 退出码判断。发布包还需单独检查
minSdk、v1 签名，并在 Android 4.4 断网环境中安装启动。

### 1.1.4 的验证记录（2026-09-28）

- 35 项站点 Node 回归、2 项分层搜索 SQLite 回归、2565 篇内容结构检查通过；`assembleRelease`、`assembleDebug`、`assembleDebugAndroidTest`、`lintDebug` 通过。
- Android 4.4.2 / API 19 / Chrome 30 模拟器断网完成 9 项基础阅读流程：全部 2565 篇目录、篇名搜索、文白与注释、字号、续读、前后篇和返回键。该次测试使用 1.1.4 的较早构建；此后改动集中在现代阅读器朗读与原生保存、更新路径，基础阅读器资源未改。
- **最终签名包**在 Android 15 / API 35 / Chrome 124 模拟器通过完整阅读器、书签持久化、备份导出导入、本机朗读入口、分享卡片、系统分享与 PNG 相册保存；MediaStore 中也可查到生成图片。在线更新的只读检查通过，官网目前仍返回 1.1.3 清单，故变更项为 0。
- 同证书签名的调试包在 API 35 通过 APK 下载地址、包名、签名和递增版本校验；API 19 调试包先前通过内容更新的摘要失败、中途下载失败和完整提交交易测试。全部 2728 个源码资产与最终 APK 逐字节一致，含 2565 篇文章；最低 API 19、v1/v2/v3 签名及原证书指纹已核对。
- 尚未在 Android 5–9 真机或模拟器运行保存位置选择器。系统 TTS 在无音频的模拟器中只能验证回调和失败提示，不能确认实际发声。线上分层搜索已补建，并通过四范围接口、分页及 Android 15 安装包 WebView 搜索界面检查；AI 回答的引文忠实性仍不能以通路成功代替验证通过。
- 1.1.4 已推送至 GitHub 并部署 Cloudflare Pages；[公开 APK](https://wenchao.foyue.org/app/wenchao-1.1.4.apk) 的 SHA-256 为 `99a5be741c9f4413d8756b56bea1083cbeb8b3170f14f0d34d0bb5cc8dfe455f`，与本地签名包一致。详细日志在 `dist/android19-validation/`；仍未验证具体厂商真机。

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
