#!/usr/bin/env python3
"""按站内语料子集化 + 词频分层，重建自托管字体（site/font/ + site/css/fonts.css）。

取代原先 fetch_fonts.py 的「原样镜像上游切片」做法。上游切法（cn-fontsource 每 192
字一片、按码位顺序）与中文行文用字完全不匹配——一篇文章的用字散布整个 CJK 区，
命中率极低。实测单篇 /a/jx-001/ 要拉 106 个切片共 4.65MB，fonts.css 本身 496KB
且 render-blocking。

本脚本改为：
  1. 只收站内真正会渲染的字（全部篇目正文 + 目录 + 页面/JS 里的中文 UI 文案），
     加 GB2312 全字表兜底（AI 回答、搜索输入等任意常用字不掉字）；
  2. 简体按语料词频排序，繁体（OpenCC cn→tw，与前端 tradify 同一份字典）排在其后
     自成连续块——简体读者永不触碰繁体分片，繁体读者也拿到按词频排好的头部；
  3. 头部 1000 字一片（覆盖语料 92.5%），尾部每 250 字一片，控制稀有字的连带下载；
  4. Noto Serif SC 用可变字体一次覆盖 400/600/900（原先同一段文字按三个字重各下一份）。

实测语料：2565 篇共用 5331 个不重复汉字；前 1000 字覆盖 92.55%，前 2000 字 98.35%。

依赖：fonttools + brotli（见 .venv）、node（跑 site/js/opencc.js 做繁体展开）。
用法：
    .venv/bin/python scripts/build_font_subset.py
源字体缓存在 .fontsrc/（已 gitignore），缺失时自动下载。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
SRC_DIR = ROOT / ".fontsrc"
FONT_DIR = SITE / "font"
OUT_CSS = SITE / "css" / "fonts.css"

# 源字体：Noto Serif SC 取 Google Fonts 可变版（一份覆盖全部字重），
# 霞鹜文楷 GB Screen 取上游 release 的完整 TTF。
SOURCES = {
  "noto": {
    "file": "NotoSerifSC.ttf",
    "url": "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    "family": "Noto Serif SC",
    "weight": "400 900",     # 可变字重区间
    # 源可变字体的 wght 轴是 200–900、默认落在 200(ExtraLight)。站内只用 400/500/600/900，
    # 把轴裁到 400–900 既砍掉用不上的插值数据，也把默认实例挪到 400——
    # 万一某个环境没应用上变体，退化成正文常规体而不是极细体。
    "axis_limits": {"wght": (400, 900)},
    "local": [],             # 访客本地基本不会装，不写 local()
  },
  "lxgw": {
    "file": "LXGWWenKaiGBScreen.ttf",
    "url": "https://github.com/lxgw/LxgwWenKai-Screen/releases/download/v1.522/LXGWWenKaiGBScreen.ttf",
    "family": "LXGW WenKai GB Screen",
    "weight": "400",
    "local": ["LXGW WenKai GB Screen"],
  },
}

HEAD_SIZE = 1000    # 头部大片：高频字密集，任何一篇都几乎全用得上，无浪费
TAIL_SIZE = 250     # 尾部小片：稀有字散落，片子越小连带下载越少

CJK_RE = re.compile(r"[㐀-鿿豈-﫿]")
# 正文之外必须成套下发的符号：ASCII、常用标点、全角、注音符号等
BASE_EXTRA = (
  "".join(chr(c) for c in range(0x20, 0x7F))
  + "".join(chr(c) for c in range(0x2000, 0x206F))
  + "".join(chr(c) for c in range(0x3000, 0x3040))
  + "".join(chr(c) for c in range(0xFE10, 0xFE20))
  + "".join(chr(c) for c in range(0xFF01, 0xFF61))
  + "×÷°±·—…‰′″€￥§¶©®™　αβγπΩ"
)


def log(msg: str) -> None:
  print(msg, flush=True)


def ensure_sources() -> None:
  SRC_DIR.mkdir(exist_ok=True)
  for key, meta in SOURCES.items():
    dest = SRC_DIR / meta["file"]
    if dest.exists() and dest.stat().st_size > 1_000_000:
      continue
    log(f"  下载 {meta['file']} …")
    req = urllib.request.Request(meta["url"], headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=600) as r, dest.open("wb") as f:
      shutil.copyfileobj(r, f)


def collect_corpus() -> tuple[Counter, str, set[str]]:
  """扫全站可渲染文本，返回 (汉字词频, 供繁体展开的语料全文, UI 文案字集)。"""
  freq: Counter = Counter()
  corpus_parts: list[str] = []

  # 篇目正文 + 目录：站点的主体文本，同时是词频依据
  for fp in sorted((SITE / "data" / "articles").glob("*.json")):
    text = fp.read_text(encoding="utf-8")
    corpus_parts.append(text)
    freq.update(ch for ch in text if CJK_RE.match(ch))
  books = (SITE / "data" / "books.json").read_text(encoding="utf-8")
  corpus_parts.append(books)
  freq.update(ch for ch in books if CJK_RE.match(ch))

  # 页面与脚本里的中文 UI 文案（"展 卷 …""载入失败"之类）也必须在字集内。
  # opencc.js 是 1.1MB 的简繁字典，收进来等于把整个汉字表拉进字集，必须排除。
  ui: set[str] = set()
  for path in SITE.rglob("*"):
    if not path.is_file() or path.name == "opencc.js":
      continue
    if path.suffix not in (".html", ".js", ".css", ".webmanifest", ".txt", ".xml"):
      continue
    # a/ 是 2565 篇的预渲染副本，字集与语料完全重合，扫它纯属白跑
    if {"font", "data", "a"} & set(path.parts):
      continue
    try:
      ui.update(ch for ch in path.read_text(encoding="utf-8") if CJK_RE.match(ch))
    except UnicodeDecodeError:
      continue

  return freq, "\n".join(corpus_parts), ui


def gb2312_chars() -> set[str]:
  """GB2312 全字表（一二级共 6763 字）兜底：AI 回答与搜索输入是任意文本，
  不在语料里的常用字若掉出字集会退化成系统字体，视觉上文白两栏会花。"""
  out = set()
  for hi in range(0xA1, 0xF8):
    for lo in range(0xA1, 0xFF):
      try:
        ch = bytes([hi, lo]).decode("gb2312")
      except UnicodeDecodeError:
        continue
      if CJK_RE.match(ch):
        out.add(ch)
  return out


def traditional_map(corpus: str) -> dict[str, list[str]]:
  """用站内 opencc.js（与前端 tradify 同一份字典）整段转繁，
  回收「简体字 → 其繁体形」的映射，供繁体块沿用简体词频排序。
  整段转而非逐字转，才能吃到词组级异体（如「乾/干」）。"""
  script = r"""
    const fs = require('fs');
    const OpenCC = require(process.argv[2]);
    const conv = OpenCC.Converter({ from: 'cn', to: 'tw' });
    const text = fs.readFileSync(process.argv[3], 'utf-8');
    const map = {};
    const N = 200000;                       // 分块转换，避免一次性吃满内存
    for (let i = 0; i < text.length; i += N) {
      const src = text.slice(i, i + N);
      const dst = conv(src);
      if (src.length !== dst.length) continue;   // 长度变了说明有一对多，跳过该块
      for (let k = 0; k < src.length; k++) {
        const a = src[k], b = dst[k];
        if (a === b || !/[㐀-鿿]/.test(b)) continue;
        (map[a] ||= {})[b] = 1;
      }
    }
    fs.writeFileSync(process.argv[4],
      JSON.stringify(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Object.keys(v)]))));
  """
  with tempfile.TemporaryDirectory() as td:
    js = Path(td) / "trad.js"
    src = Path(td) / "corpus.txt"
    out = Path(td) / "map.json"
    js.write_text(script, encoding="utf-8")
    src.write_text(corpus, encoding="utf-8")
    subprocess.run(
      ["node", "--max-old-space-size=4096", str(js),
       str(SITE / "js" / "opencc.js"), str(src), str(out)],
      check=True)
    return json.loads(out.read_text(encoding="utf-8"))


def build_order(freq: Counter, trad: dict[str, list[str]], ui: set[str]) -> list[str]:
  """排出最终字序：简体按词频 → 繁体专用字（沿用其简体源字的词频）→ 兜底字表。
  繁体块排在简体块之后且自成连续区间，简体读者的分片永远不会被繁体字拖胖。"""
  simp = [ch for ch, _ in freq.most_common()]
  seen = set(simp)

  trad_only: list[str] = []
  for ch in simp:                      # 依简体词频遍历，繁体块自然继承同一顺序
    for t in trad.get(ch, []):
      if t not in seen:
        seen.add(t)
        trad_only.append(t)

  rest = sorted((ui | gb2312_chars()) - seen)
  return simp + trad_only + rest


def make_tiers(order: list[str]) -> list[str]:
  tiers = ["".join(order[:HEAD_SIZE])]
  for i in range(HEAD_SIZE, len(order), TAIL_SIZE):
    tiers.append("".join(order[i:i + TAIL_SIZE]))
  return tiers


def unicode_range(text: str) -> str:
  """把字符集压成紧凑的 unicode-range（连续码位合并成区间）。"""
  cps = sorted({ord(c) for c in text})
  parts, start, prev = [], cps[0], cps[0]
  for cp in cps[1:]:
    if cp == prev + 1:
      prev = cp
      continue
    parts.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
    start = prev = cp
  parts.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
  return ",".join(parts)


def subset(src: Path, dest: Path, text: str, flavor: str | None = None) -> None:
  from fontTools import subset as ftsubset
  args = [
    str(src), f"--text={text}", f"--output-file={dest}",
    "--layout-features=",      # 横排中文用不到 GSUB/GPOS，整表丢掉
    "--no-hinting",
    "--desubroutinize",
    "--drop-tables+=DSIG",
    "--name-IDs=1,2,3,4,6",
    "--notdef-outline",
  ]
  if flavor:
    args.append(f"--flavor={flavor}")
  ftsubset.main(args)


def main() -> None:
  log("==> 1/5 准备源字体")
  ensure_sources()

  log("==> 2/5 收集站内字集")
  freq, corpus, ui = collect_corpus()
  log(f"    语料不重复汉字 {len(freq)}，UI 文案 {len(ui)}")

  log("==> 3/5 繁体展开（opencc.js）")
  trad = traditional_map(corpus)
  order = build_order(freq, trad, ui)
  tiers = make_tiers(order)
  total = sum(freq.values())
  cov = lambda n: sum(c for _, c in freq.most_common(n)) / total * 100
  log(f"    总字集 {len(order)}，分 {len(tiers)} 片；"
      f"头片 {HEAD_SIZE} 字覆盖语料 {cov(HEAD_SIZE):.1f}%")

  log("==> 4/5 子集化")
  # 两段式：先把 26MB 源字体压到全字集（一次，慢），再从这份小字体切片（快）。
  # 直接对源字体切 N 次，等于把 N 次 26MB 解析成本全付一遍。
  # 中间产物按字集指纹缓存进 .fontsrc/，只调分层参数时重跑就秒出。
  fp = hashlib.sha1("".join(order).encode()).hexdigest()[:10]
  bases = {}
  for key, meta in SOURCES.items():
    base = SRC_DIR / f"{key}-base-{fp}.ttf"
    if not base.exists():
      for stale in SRC_DIR.glob(f"{key}-base-*.ttf"):
        stale.unlink()
      subset(SRC_DIR / meta["file"], base, "".join(order) + BASE_EXTRA)
      if meta.get("axis_limits"):
        # 裁轴放在子集化之后：对 9000 字的中间体做插值，比对 25MB 源字体快一个量级
        from fontTools.ttLib import TTFont
        from fontTools.varLib import instancer
        font = TTFont(base)
        instancer.instantiateVariableFont(
          font, meta["axis_limits"], inplace=True, updateFontNames=True)
        font.save(base)
    bases[key] = base
    log(f"    {key}: 全字集中间体 {base.stat().st_size / 1048576:.1f}MB")

  if FONT_DIR.exists():
    shutil.rmtree(FONT_DIR)     # 旧切片命名规则不同，留着就是死文件
  blocks: list[str] = []
  for key, meta in SOURCES.items():
    out_dir = FONT_DIR / key
    out_dir.mkdir(parents=True)
    for i, tier in enumerate(tiers):
      text = tier + (BASE_EXTRA if i == 0 else "")
      dest = out_dir / f"{key}-{i:02d}.woff2"
      subset(bases[key], dest, text, "woff2")
      src_attr = "".join(f"local('{n}'), " for n in meta["local"])
      blocks.append(
        "@font-face{"
        f"font-family:'{meta['family']}';"
        "font-style:normal;"
        f"font-weight:{meta['weight']};"
        "font-display:swap;"
        f"src:{src_attr}url(/font/{key}/{dest.name}) format('woff2');"
        f"unicode-range:{unicode_range(text)}"
        "}"
      )
    size = sum(f.stat().st_size for f in out_dir.glob("*.woff2"))
    log(f"    {key}: {len(tiers)} 片共 {size / 1048576:.2f}MB")

  log("==> 5/5 生成 fonts.css")
  header = (
    "/* 自托管字体（scripts/build_font_subset.py 生成，勿手改）。\n"
    "   按站内语料子集化 + 词频分层：头片高频字、尾片每 250 字一档，\n"
    "   繁体块紧随简体块，简体读者不会连带下载繁体分片。 */\n"
  )
  OUT_CSS.write_text(header + "\n".join(blocks) + "\n", encoding="utf-8")
  log(f"    fonts.css {OUT_CSS.stat().st_size / 1024:.1f}KB，{len(blocks)} 条 @font-face")
  log("完成。记得给 site/index.html 的资源版本串升版并重跑 build_article_pages.py。")


if __name__ == "__main__":
  main()
