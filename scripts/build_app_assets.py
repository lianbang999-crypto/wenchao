#!/usr/bin/env python3
"""把站点内容打进安卓 APP 的 assets —— 让 APP 装完即可离线阅读。

为什么要有这一步：
  旧版 APP 是 TWA 外壳，包里一篇经文都没有（2.5MB），每次打开都得联网
  从 wenchao.foyue.org 现取。站点在 Cloudflare 上，国内网络一波动就打不开。
  现在改为把内容随 APK 一起装进手机，网络只用于「检查更新」。

打包哪些、不打包哪些：
  · 打包 —— 阅读器真正要用的：data/(篇 JSON 与目录) font/ img/ css/ js/
            以及 v/ t/ ask/ ying/ 这几处站内页面（合计不到 450KB，一并带上
            省得 APP 里点进去 404）。
  · 不打包 —— a/：2565 个每篇一份的 SEO 静态页，46MB。阅读器走的是 SPA 路由
            （app.js 的 goArticle 用 pushState + fetch 篇 JSON），正常点击根本
            不会请求它们；冷启动直接落到 /a/xxx/ 的情况，由 MainActivity 的
            SPA 回退兜到 index.html。省下的 46MB 是包体的大头。
  · 不打包 —— sw.js：内容已在本地，再套一层 Service Worker 只会和 assets
            加载互相打架。app.js 会按域名判断，在 APP 里跳过注册。
  · 不打包 —— _headers/robots.txt/sitemap.xml/llms.txt/i/：服务端与 SEO 专用。

顺带产出两份内容清单，用于增量更新（内容改了不必换整包）：
  · assets/content-version.json  —— 随 APK 出厂，记录「这个包里的内容是哪一版」
  · site/app/content-manifest.json —— 发到线上，APP 拿它比对，只下变动的篇目

用法：
  python3 scripts/build_app_assets.py          # 打包
  python3 scripts/build_app_assets.py --check   # 只看会打包什么，不写文件
"""
import hashlib
import io
import json
import os
import shutil
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
ASSETS = os.path.join(ROOT, "app-android", "app", "src", "main", "assets")
MANIFEST_OUT = os.path.join(SITE, "app", "content-manifest.json")

# 线上站点地址：APP 页面跑在本地域上，接口类的相对地址要改写成它才打得到后端
SITE_ORIGIN = "https://wenchao.foyue.org"

# 整目录拷贝
DIRS = ["data", "font", "img", "css", "js", "v", "t", "ask", "ying"]
# 根目录下的单文件
FILES = ["index.html", "config.js", "manifest.webmanifest",
         "icon.svg", "apple-touch-icon.png", "favicon.ico", "404.html"]
# 即便在上述目录里也要剔除的
SKIP_NAMES = {".DS_Store", "sw.js"}

# 追加到 config.js 末尾：把相对的接口地址改成绝对，并留下环境标记。
# 用追加而非改写原有行——原文怎么写都不影响这里，升级站点配置不会打架。
CONFIG_PATCH = """
/* ===== 以下由 scripts/build_app_assets.py 自动追加，仅存在于 APP 包内 =====
   APP 的页面跑在 appassets.androidplatform.net 这个本地域上，'/api/ai' 这类
   相对地址会落到本地、打不到后端，故在此逐个改写为绝对地址。
   离线时这些接口自然失败，各自的调用点已有降级分支，不影响正文阅读。 */
(function () {
  var C = window.WENCHAO_CONFIG || (window.WENCHAO_CONFIG = {});
  var ORIGIN = '%s';
  var abs = function (u) { return (u && u.charAt(0) === '/') ? ORIGIN + u : u; };
  C.aiEndpoint = abs(C.aiEndpoint);
  C.apkUrl = abs(C.apkUrl);
  C.siteOrigin = ORIGIN;
  C.isOfflineApp = true;      // 供页面判断「我在离线 APP 里」
})();
""" % SITE_ORIGIN


def sha(path, n=12):
    """取文件内容摘要前 n 位，用于增量更新时判断某篇是否变过。"""
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()[:n]


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit)
        n /= 1024.0


def copy_tree(src, dst):
    """拷贝目录，剔除 SKIP_NAMES；返回 (文件数, 字节数)。"""
    cnt = size = 0
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in SKIP_NAMES]
        rel = os.path.relpath(dirpath, src)
        target = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target, exist_ok=True)
        for name in filenames:
            if name in SKIP_NAMES:
                continue
            s = os.path.join(dirpath, name)
            shutil.copy2(s, os.path.join(target, name))
            cnt += 1
            size += os.path.getsize(s)
    return cnt, size


def build_manifest():
    """扫描篇 JSON 与目录，生成内容清单。版本号取内容聚合摘要，内容没变则版本号不变。"""
    arts_dir = os.path.join(SITE, "data", "articles")
    articles = {}
    for name in sorted(os.listdir(arts_dir)):
        if not name.endswith(".json"):
            continue
        articles[name[:-5]] = sha(os.path.join(arts_dir, name))
    books = sha(os.path.join(SITE, "data", "books.json"))

    agg = hashlib.sha1()
    agg.update(books.encode())
    for k in sorted(articles):
        agg.update((k + articles[k]).encode())
    version = datetime.now(timezone.utc).strftime("%Y%m%d") + "-" + agg.hexdigest()[:8]

    return {
        "version": version,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(articles),
        "books": books,
        "articles": articles,
    }


def main():
    check_only = "--check" in sys.argv
    if not os.path.isdir(SITE):
        sys.exit("找不到站点目录：" + SITE)

    manifest = build_manifest()
    print("内容版本：%s（%d 篇）" % (manifest["version"], manifest["count"]))

    if check_only:
        total = 0
        for d in DIRS:
            p = os.path.join(SITE, d)
            if not os.path.isdir(p):
                print("  ! 缺目录 %s，跳过" % d)
                continue
            n = sum(os.path.getsize(os.path.join(dp, f))
                    for dp, _, fs in os.walk(p) for f in fs)
            total += n
            print("  %-6s %s" % (d, human(n)))
        print("合计约 %s（未压缩）；a/ 已排除" % human(total))
        return

    # 全量重建：assets 是纯构建产物，直接清掉重来，避免删过的文件残留在包里
    if os.path.isdir(ASSETS):
        shutil.rmtree(ASSETS)
    os.makedirs(ASSETS, exist_ok=True)

    total_files = total_size = 0
    for d in DIRS:
        src = os.path.join(SITE, d)
        if not os.path.isdir(src):
            print("  ! 缺目录 %s，跳过" % d)
            continue
        c, s = copy_tree(src, os.path.join(ASSETS, d))
        total_files += c
        total_size += s
        print("  %-6s %5d 个文件  %s" % (d, c, human(s)))

    for name in FILES:
        src = os.path.join(SITE, name)
        if not os.path.isfile(src):
            print("  ! 缺文件 %s，跳过" % name)
            continue
        shutil.copy2(src, os.path.join(ASSETS, name))
        total_files += 1
        total_size += os.path.getsize(src)

    # config.js 追加 APP 专用覆盖段
    cfg = os.path.join(ASSETS, "config.js")
    with io.open(cfg, "a", encoding="utf-8") as f:
        f.write(CONFIG_PATCH)

    # 出厂内容清单（随 APK 走）
    with io.open(os.path.join(ASSETS, "content-version.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    # 线上清单（供 APP 比对；与出厂清单同构，发布站点时一并上传）
    os.makedirs(os.path.dirname(MANIFEST_OUT), exist_ok=True)
    with io.open(MANIFEST_OUT, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))

    print("—" * 46)
    print("assets 就绪：%d 个文件，%s（未压缩）" % (total_files, human(total_size)))
    print("  %s" % ASSETS)
    print("线上比对清单：%s" % os.path.relpath(MANIFEST_OUT, ROOT))
    print("提示：APK 会对 assets 再压缩一轮，实际增量约 %s" % human(total_size * 0.56))


if __name__ == "__main__":
    main()
