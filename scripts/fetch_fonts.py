#!/usr/bin/env python3
"""自托管字体抓取：Google Fonts（Noto Serif SC 400/600/900）+ jsdelivr（霞鹜文楷 GB Screen）。

大陆访问 fonts.googleapis.com / cdn.jsdelivr.net 常被阻断，且两份字体 CSS 是
render-blocking——外链挂起时首屏要干等到超时。故把切片 woff2 全部落到
site/font/{noto,lxgw}/，合成本地 site/css/fonts.css（保留 unicode-range 按需加载：
浏览器只取页面实际用到的切片，托管全量不影响访客流量）。

重跑安全：已存在且非空的 woff2 跳过；css 每次重写。
"""

from __future__ import annotations

import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
FONT_DIR = SITE / "font"
OUT_CSS = SITE / "css" / "fonts.css"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")   # 现代 UA 才拿得到 woff2+unicode-range 版 CSS
NOTO_CSS_URL = ("https://fonts.googleapis.com/css2"
                "?family=Noto+Serif+SC:wght@400;600;900&display=swap")
LXGW_BASE = "https://cdn.jsdelivr.net/npm/cn-fontsource-lxgw-wen-kai-gb-screen@1.0.6/"
LXGW_CSS_URL = LXGW_BASE + "font.css"


def http_get(url: str) -> bytes:
  req = urllib.request.Request(url, headers={"User-Agent": UA})
  with urllib.request.urlopen(req, timeout=60) as r:
    return r.read()


def download(url: str, dest: Path) -> str:
  if dest.exists() and dest.stat().st_size > 0:
    return "skip"
  dest.write_bytes(http_get(url))
  return "ok"


def main() -> None:
  (FONT_DIR / "noto").mkdir(parents=True, exist_ok=True)
  (FONT_DIR / "lxgw").mkdir(parents=True, exist_ok=True)
  jobs: list[tuple[str, Path]] = []

  # Noto Serif SC：绝对 URL → /font/noto/<文件名>
  noto = http_get(NOTO_CSS_URL).decode("utf-8")
  def noto_sub(m: re.Match) -> str:
    url = m.group(1)
    name = url.rsplit("/", 1)[-1]
    jobs.append((url, FONT_DIR / "noto" / name))
    return f"url(/font/noto/{name})"
  noto = re.sub(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", noto_sub, noto)

  # 霞鹜文楷 GB Screen：相对 URL → /font/lxgw/<文件名>；顺带补 font-display:swap
  lxgw = http_get(LXGW_CSS_URL).decode("utf-8")
  def lxgw_sub(m: re.Match) -> str:
    name = m.group(1)
    jobs.append((LXGW_BASE + name, FONT_DIR / "lxgw" / name))
    return f"url(/font/lxgw/{name})"
  lxgw = re.sub(r"url\('([^']+\.woff2)'\)", lxgw_sub, lxgw)
  lxgw = lxgw.replace(";unicode-range:", ";font-display: swap;unicode-range:")

  OUT_CSS.write_text(
    "/* 自托管字体（scripts/fetch_fonts.py 生成，勿手改）：\n"
    "   Noto Serif SC 400/600/900（正文宋体）+ 霞鹜文楷 GB Screen（楷体兜底）。\n"
    "   unicode-range 切片保留原样，浏览器按需取用。 */\n" + noto + "\n" + lxgw,
    encoding="utf-8")

  results = {"ok": 0, "skip": 0, "fail": 0}
  def run(job: tuple[str, Path]) -> None:
    url, dest = job
    try:
      results[download(url, dest)] += 1
    except Exception as e:      # 单片失败不致命：该片回退系统字体，重跑可补
      results["fail"] += 1
      print(f"  FAIL {url}: {e}", file=sys.stderr)
  with ThreadPoolExecutor(max_workers=12) as ex:
    list(ex.map(run, jobs))

  total = sum(f.stat().st_size for f in FONT_DIR.rglob("*.woff2"))
  print(f"fonts.css written ({OUT_CSS.stat().st_size // 1024}KB), "
        f"woff2 下载 {results['ok']} / 跳过 {results['skip']} / 失败 {results['fail']}，"
        f"共 {len(jobs)} 片 {total / 1048576:.1f}MB")
  if results["fail"]:
    sys.exit(1)


if __name__ == "__main__":
  main()
