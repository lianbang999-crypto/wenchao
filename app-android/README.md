# 印光文钞 · Android APP（TWA 工程）

Bubblewrap 生成的 Trusted Web Activity 工程：APP 即 `https://wenchao.foyue.org`
的原生壳，站点更新即 APP 更新（壳本身极少需要发版）。

## 产物

| 文件 | 用途 |
|---|---|
| `app-release-signed.apk` | 官网直接分发（用户侧「安装未知应用」） |
| `app-release-bundle.aab` | Google Play 上架（Play Console 只收 AAB） |

包名 `org.foyue.wenchao`（**发布后永不可改**）· minSdk 21（Android 5.0+）。

## 重新构建

```bash
cd app-android
export BUBBLEWRAP_KEYSTORE_PASSWORD=$(grep '^密码' keystore/KEYSTORE-INFO.txt | awk '{print $2}')
export BUBBLEWRAP_KEY_PASSWORD="$BUBBLEWRAP_KEYSTORE_PASSWORD"
npx @bubblewrap/cli build --skipPwaValidation
```

改壳配置（名称/颜色/图标/版本）→ 编辑 `twa-manifest.json` → `npx @bubblewrap/cli update --skipVersionUpgrade` → 再 build。

发新版：`twa-manifest.json` 里 `appVersionCode` +1、`appVersion` 改语义版本号，再 update + build。

本机环境要求（已配好，写在 `~/.bubblewrap/config.json`）：
- `jdkPath` 指 JDK **顶层目录**（macOS 下工具自己拼 `/Contents/Home`）
- `androidSdkPath` 指 `<SDK>/cmdline-tools/latest`（不是 SDK 根）
- 工程 `local.properties` 的 `sdk.dir` 指真正的 SDK 根（gradle 用）

## ⚠️ 签名密钥（keystore/ 目录，已 gitignore）

`keystore/wenchao-upload.keystore` + `KEYSTORE-INFO.txt`（含密码）。

**丢失 = 这个 APP 永远无法再更新**，只能换包名重新上架、已装用户全部流失。
立即备份到至少两处（密码管理器 + 加密网盘）。密码与文件分开存。

## assetlinks.json（双指纹，关键）

`site/.well-known/assetlinks.json` 声明「此域名信任此 APP」，Chrome 据此去掉地址栏。
当前已含**上传密钥**指纹：

```
E6:09:86:0C:AE:98:35:78:4E:B4:93:38:00:15:E8:5B:1E:90:C4:43:9E:C2:3C:2E:23:65:37:2F:C1:AF:2A:97
```

**Play 上架后必须再加一个指纹**：Play App Signing 会用 Google 保管的发布密钥重签，
指纹与上传密钥不同。否则 Play 装的 APP 打开带地址栏（官网 APK 版不受影响）。

补法：Play Console → 测试和发布 → 应用签名 → 复制「应用签名密钥证书」的 SHA-256
→ 追加进 `sha256_cert_fingerprints` 数组（两个指纹并存）→ 重新部署站点。

验证：部署后访问
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://wenchao.foyue.org&relation=delegate_permission/common.handle_all_urls`

## Google Play 上架清单（个人开发者账号）

1. **先想清楚**：个人账号的真实姓名+地址会公开显示在商店页（强制）
2. 注册 Play Console（$25 一次性）→ 身份验证
3. 创建应用 → 上传 `app-release-bundle.aab` → **开启 Play App Signing**
4. 商店资料：名称「印光法师文钞」、简介、截图（手机 2+ 张）、512 图标（工程里 `store_icon.png`）、置于「图书与工具书」类
5. **数据安全表单如实填**：
   - 「问文钞」AI 问答会把用户提问发给第三方模型服务（DeepSeek 经自有 Worker 代理）→ 申报「收集用户生成内容 / 不与身份关联 / 用于应用功能」
   - 收藏/划线/进度存本地 localStorage，不上传
6. 隐私政策：需一个公开 URL（建议 `wenchao.foyue.org/privacy/`，内容照第 5 条如实写）
7. 内容分级问卷 → 宗教内容如实选
8. 新个人账号首次发生产版本前需**封闭测试**（人数/天数以 Console 实时提示为准）— 组织账号免此项
9. 发布后：回到上面「assetlinks 双指纹」补 Play 签名指纹

## 官网 APK 分发注意

- APK 无自动更新：站内后续可加版本提示（壳更新极少，站点内容更新不需要发版）
- 下载页要附「安装未知应用」引导（各国产 ROM 会拦）
- 每次发新 APK 记得同步更新下载页的版本号与文件
