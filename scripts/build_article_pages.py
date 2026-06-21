#!/usr/bin/env python3
"""Generate crawlable article permalink pages for the static site."""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import shutil
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
ARTICLE_DIR = SITE / "data" / "articles"
OUT_DIR = SITE / "a"
VOL_DIR = SITE / "v"
ORIGIN = os.environ.get("SITE_ORIGIN", "https://wenchao.foyue.org").rstrip("/")
SITE_NAME = "印光法师文钞"
AUTHOR = "印光法师"


def h(value: object) -> str:
  return html.escape(str(value or ""), quote=True)


def clean_text(value: str) -> str:
  value = re.sub(r"\[\d{1,3}\]", "", value or "")
  return re.sub(r"\s+", " ", value).strip()


def clip(value: str, n: int) -> str:
  value = clean_text(value)
  return value if len(value) <= n else value[: n - 1].rstrip() + "…"


def article_path(aid: str) -> str:
  """文章页站内相对路径，与 app.js articleHref 同口径。"""
  return f"/a/{quote(aid, safe='')}/"


def vol_path(vid: str) -> str:
  """分册聚合页站内相对路径。"""
  return f"/v/{quote(vid, safe='')}/"


def flatten_books(books: list[dict]) -> list[dict]:
  out: list[dict] = []
  for vol in books:
    for juan in vol.get("juans", []):
      for cat in juan.get("cats", []):
        for item in cat.get("items", []):
          rec = dict(item)
          rec["_volumeName"] = vol.get("name", "")
          rec["_group"] = vol.get("group", "")
          rec["_juan"] = juan.get("name", "")
          rec["_category"] = cat.get("name", "")
          out.append(rec)
  return out


def description_for(art: dict) -> str:
  if art.get("summary"):
    return clip(art["summary"], 150)
  for seg in art.get("segments", []):
    for key in ("orig", "trans"):
      for p in seg.get(key, []):
        if clean_text(p):
          return clip(p, 150)
  return "印光法师文钞文白对照阅读。"


def body_for(art: dict) -> str:
  chunks: list[str] = []
  for seg in art.get("segments", []):
    orig = seg.get("orig", [])
    trans = seg.get("trans", [])
    paired = not art.get("plain") and orig and len(orig) == len(trans)
    if art.get("plain"):
      chunks.extend(f'<p class="p-orig" style="text-indent:0">{h(p)}</p>' for p in orig)
    elif paired:
      for o, t in zip(orig, trans):
        chunks.append(
          '<div class="para-pair">'
          f'<p class="p-orig">{h(o)}</p>'
          f'<p class="p-trans">{h(t)}</p>'
          "</div>"
        )
    else:
      both = bool(orig and trans)
      if orig:
        if both:
          chunks.append('<div class="block-label">原 文</div>')
        chunks.extend(f'<p class="p-orig">{h(p)}</p>' for p in orig)
      if trans:
        if both:
          chunks.append('<div class="block-label">白 话</div>')
        chunks.extend(f'<p class="p-trans">{h(p)}</p>' for p in trans)
    if seg.get("src"):
      # 嘉言录条目出处：能定位到文钞原篇的（srcId）渲染成可抓取链接
      if seg.get("srcId"):
        chunks.append(
          f'<a class="seg-src linked" href="{article_path(seg["srcId"])}">{h(seg["src"])}</a>'
        )
      else:
        chunks.append(f'<p class="seg-src">{h(seg["src"])}</p>')
  return "\n".join(chunks)


def notes_for(art: dict) -> str:
  notes: list[dict] = []
  for seg in art.get("segments", []):
    notes.extend(seg.get("notes", []))
  if not notes:
    return ""
  items = []
  for note in notes:
    term = f'<span class="note-term">【{h(note.get("term"))}】</span>' if note.get("term") else ""
    items.append(
      '<p class="note-item">'
      f'<span class="note-n">[{h(note.get("n", ""))}]</span>'
      f'{term}{h(note.get("text", ""))}</p>'
    )
  return '<section class="notes-sec"><h3>注 释</h3>' + "\n".join(items) + "</section>"


def artnav_html(prev: dict | None, nxt: dict | None) -> str:
  """篇间导航（上一篇/下一篇），用真链接供爬虫顺序爬行、传递权重。"""
  def cell(rec: dict | None, label: str) -> str:
    if not rec:
      return "<span></span>"
    return (
      f'<a href="{article_path(rec["id"])}">'
      f'<small>{label}</small>{h(rec.get("title", ""))}</a>'
    )
  return f'<nav class="art-nav">{cell(prev, "上一篇")}{cell(nxt, "下一篇")}</nav>'


def backrefs_html(art: dict) -> str:
  """反向链接：本篇入选《嘉言录》的条目（文钞篇 → 嘉言录）。"""
  refs = art.get("backrefs") or []
  if not refs:
    return ""
  items = []
  for r in refs:
    n = r.get("n", 0) or 0
    badge = f'<span class="br-n">{h(n)} 则</span>' if n > 1 else ""
    items.append(
      f'<a class="backref" href="{article_path(r["a"])}">'
      f'<span class="br-arrow">❖</span>{h(r.get("t", ""))}{badge}</a>'
    )
  return '<section class="backrefs"><h3>入选《嘉言录》</h3>' + "".join(items) + "</section>"


def xuandu_html(art: dict) -> str:
  """《文钞》选读篇目，可定位者（aid）渲染成直达文钞原篇的链接。"""
  secs = art.get("xuandu") or []
  if not secs:
    return ""
  parts = []
  for sec in secs:
    parts.append(f'<h3 class="xd-sec">{h(sec.get("sec", ""))}</h3>')
    for it in sec.get("items", []):
      mark = " xd-mark" if it.get("m") else ""
      if it.get("aid"):
        parts.append(
          f'<a class="xd-link{mark}" href="{article_path(it["aid"])}">{h(it.get("t", ""))}</a>'
        )
      else:
        parts.append(f'<span class="xd-item{mark}">{h(it.get("t", ""))}</span>')
  return '<div class="xuandu">' + "".join(parts) + "</div>"


def prerender_main(art: dict, prev: dict | None = None, nxt: dict | None = None) -> str:
  # 面包屑：首页 › 分册聚合页 › 本篇（前两级为可抓取链接，承接权重；与 app.js 同口径）
  vol_id = art.get("volume", "")
  vol_name = art.get("volumeName", "")
  rest = " · ".join(
    h(x) for x in [
      short_juan(art.get("juan", "")),
      art.get("category", ""),
      art.get("translator", ""),
    ] if x
  )
  crumb_html = '<a href="/">文钞</a>'
  if vol_name and vol_id:
    crumb_html += f' · <a href="{vol_path(vol_id)}">{h(vol_name)}</a>'
  elif vol_name:
    crumb_html += f' · {h(vol_name)}'
  if rest:
    crumb_html += f' · {rest}'
  mode = "orig" if art.get("plain") else "both"
  lines = [
    '<main class="reader" id="reader">',
    '  <div class="reader-inner seo-prerender">',
    '    <header class="art-head">',
    f'      <div class="art-crumb">{crumb_html}</div>',
    f'      <h1 class="art-title">{h(art.get("title", ""))}</h1>',
    '      <div class="rule"></div>',
    '    </header>',
  ]
  if art.get("summary"):
    lines.append(f'    <div class="art-summary"><b>提 要</b>{h(art["summary"])}</div>')
  lines.extend([
    f'    <article class="art-body" data-mode="{mode}">',
    body_for(art),
    '    </article>',
  ])
  # 顺序与 app.js renderArticle 一致：正文 → 选读 → 注释 → 反链 → 篇间导航
  for extra in (xuandu_html(art), notes_for(art), backrefs_html(art), artnav_html(prev, nxt)):
    if extra:
      lines.append(f'    {extra}')
  lines.extend([
    '  </div>',
    '</main>',
  ])
  return "\n".join(lines)


def clean_translator(value: str) -> str:
  """只取单一、干净的译者名写进结构化数据；多人/含校审等脏值一律省略，不臆造。"""
  value = (value or "").strip()
  if not value or "校审" in value or "、" in value or " " in value:
    return ""
  return value[:-1] if value.endswith("译") else value


def jsonld_for(art: dict, title: str, desc: str, url: str) -> str:
  vol = art.get("volumeName") or art.get("group") or SITE_NAME
  data: dict = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": title,
    "description": desc,
    "inLanguage": "zh-Hans",
    "url": url,
    "mainEntityOfPage": url,
    "author": {"@type": "Person", "name": AUTHOR},
    "isPartOf": {"@type": "Book", "name": vol, "author": {"@type": "Person", "name": AUTHOR}},
    "publisher": {"@type": "Organization", "name": SITE_NAME, "url": ORIGIN + "/"},
  }
  translator = clean_translator(art.get("translator", ""))
  if translator:
    data["translator"] = {"@type": "Person", "name": translator}
  raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
  raw = raw.replace("<", "\\u003c")  # 防止正文里偶含的 < 截断 </script>
  return f'<script type="application/ld+json">{raw}</script>'


def article_breadcrumb_ld(art: dict, url: str) -> str:
  """文章页面包屑结构化数据：首页 → 分册聚合页 → 本篇。"""
  items = [{"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": ORIGIN + "/"}]
  vol_id = art.get("volume", "")
  vol_name = art.get("volumeName", "")
  if vol_id and vol_name:
    items.append({
      "@type": "ListItem", "position": 2,
      "name": vol_name, "item": f"{ORIGIN}{vol_path(vol_id)}",
    })
  items.append({
    "@type": "ListItem", "position": len(items) + 1,
    "name": art.get("title", ""), "item": url,
  })
  return _ld({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    "itemListElement": items,
  })


def page_html(index_html: str, art: dict, url: str,
              prev: dict | None = None, nxt: dict | None = None) -> str:
  # 篇名作 og:title/twitter:title 用全称，与 <title> 同口径
  full_title = f'{art.get("title", "")} · 印光法师文钞'
  desc = description_for(art)
  doc = index_html
  # 剥离首页专属的社交/结构化数据块，避免与本篇的 og/twitter/JSON-LD 重复
  doc = re.sub(r"\n?<!-- HOME-SEO-START\b.*?HOME-SEO-END -->\n?", "\n", doc, count=1, flags=re.S)
  if "<base " not in doc:
    doc = doc.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<base href="/">', 1)
  doc = re.sub(r"<title>.*?</title>", f"<title>{h(full_title)}</title>", doc, count=1, flags=re.S)
  desc_meta = f'<meta name="description" content="{h(desc)}">'
  doc = re.sub(r'<meta name="description" content="[^"]*">', desc_meta, doc, count=1)
  seo = (
    f'\n<link rel="canonical" href="{h(url)}">'
    f'\n<meta property="og:type" content="article">'
    f'\n<meta property="og:title" content="{h(full_title)}">'
    f'\n<meta property="og:description" content="{h(desc)}">'
    f'\n<meta property="og:url" content="{h(url)}">'
    f'\n<meta property="og:site_name" content="{h(SITE_NAME)}">'
    f'\n<meta property="og:locale" content="zh_CN">'
    f'\n<meta name="twitter:card" content="summary">'
    f'\n<meta name="twitter:title" content="{h(full_title)}">'
    f'\n<meta name="twitter:description" content="{h(desc)}">'
    f'\n{jsonld_for(art, full_title, desc, url)}'
    f'\n{article_breadcrumb_ld(art, url)}'
  )
  doc = doc.replace(desc_meta, desc_meta + seo, 1)
  marker = '<main class="reader" id="reader"></main>'
  if marker not in doc:
    raise RuntimeError("site/index.html reader placeholder not found")
  return doc.replace(marker, prerender_main(art, prev, nxt), 1)


def short_juan(name: str) -> str:
  """卷名缩写，与 app.js shortJuan 同口径：「增广印光法师文钞卷第一」→「卷第一」。"""
  s = re.sub(r"^(增广)?印光法师文钞(续编|三编)?", "", name or "")
  return s or name


def nav_title(title: str) -> str:
  """目录显示用篇名，去掉卷首长标题尾部的编者注，与 app.js navTitle 同口径。"""
  return re.sub(r"（附录于后）$", "", title or "")


def _ld(data: dict) -> str:
  raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
  return f'<script type="application/ld+json">{raw}</script>'


def volume_page_html(vol: dict, css_link: str, all_vols: list[tuple]) -> str:
  """单部分册的纯静态目录页：列出该部全部篇目链接，作 SEO 枢纽页。"""
  vid = vol["id"]
  name = vol.get("name", "")
  group = vol.get("group", "")
  url = f"{ORIGIN}/v/{quote(vid, safe='')}/"
  count = sum(len(c.get("items", [])) for j in vol.get("juans", []) for c in j.get("cats", []))
  desc = clip(f"{name}全部篇目共 {count} 篇，文白对照阅读。{group}", 150)

  rows: list[str] = []
  for juan in vol.get("juans", []):
    rows.append(f'<h2 class="vi-juan">{h(short_juan(juan.get("name", "")))}</h2>')
    for cat in juan.get("cats", []):
      cname = cat.get("name", "")
      if cname and cname != "正文":
        rows.append(f'<h3 class="vi-cat">{h(cname)}</h3>')
      for it in cat.get("items", []):
        rows.append(
          f'<a class="vi-link" href="{article_path(it["id"])}">{h(nav_title(it.get("title", "")))}</a>'
        )
  index_body = "\n      ".join(rows)

  others = "".join(
    f'<a href="/v/{quote(ov_id, safe="")}/">{h(ov_name)}</a>'
    for ov_id, ov_name in all_vols if ov_id != vid
  )

  breadcrumb = _ld({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": ORIGIN + "/"},
      {"@type": "ListItem", "position": 2, "name": name, "item": url},
    ],
  })
  collection = _ld({
    "@context": "https://schema.org", "@type": "CollectionPage",
    "name": f"{name} · {SITE_NAME}", "url": url, "inLanguage": "zh-Hans",
    "isPartOf": {"@type": "WebSite", "name": SITE_NAME, "url": ORIGIN + "/"},
  })

  return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<base href="/">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{h(name)} · 印光法师文钞</title>
<meta name="description" content="{h(desc)}">
<link rel="canonical" href="{h(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{h(name)} · 印光法师文钞">
<meta property="og:description" content="{h(desc)}">
<meta property="og:url" content="{h(url)}">
<meta property="og:site_name" content="印光法师文钞">
<meta property="og:locale" content="zh_CN">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{h(name)} · 印光法师文钞">
<meta name="twitter:description" content="{h(desc)}">
<meta name="theme-color" content="#f6f1e6">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;900&display=swap">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/cn-fontsource-lxgw-wen-kai-gb-screen@1.0.6/font.css">
<link rel="stylesheet" href="{h(css_link)}">
{breadcrumb}
{collection}
</head>
<body>
<header class="topbar">
  <a class="icon-btn" href="/" aria-label="返回首页">
    <svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
  </a>
  <a class="topbar-title" href="/">印光法师文钞</a>
  <span class="icon-btn" aria-hidden="true"></span>
</header>
<main class="reader">
  <div class="reader-inner">
    <nav class="crumb-nav"><a href="/">印光法师文钞</a> › <span aria-current="page">{h(name)}</span></nav>
    <header class="art-head">
      <div class="art-crumb">{h(group)}</div>
      <h1 class="art-title">{h(name)}</h1>
      <div class="rule"></div>
    </header>
    <div class="vol-index">
      {index_body}
    </div>
    <nav class="vol-others">
      <h3>其余分册</h3>
      {others}
    </nav>
  </div>
</main>
</body>
</html>
"""


def write_volume_pages(books: list[dict], css_link: str) -> list[str]:
  if VOL_DIR.exists():
    shutil.rmtree(VOL_DIR)
  VOL_DIR.mkdir(parents=True)
  all_vols = [(v["id"], v.get("name", "")) for v in books]
  for vol in books:
    out = VOL_DIR / vol["id"] / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(volume_page_html(vol, css_link, all_vols), encoding="utf-8")
  return [v["id"] for v in books]


def write_sitemap(items: list[dict], volumes: list[str]) -> None:
  today = dt.date.today().isoformat()
  urls = [
    f"  <url><loc>{h(ORIGIN)}/</loc><lastmod>{today}</lastmod><priority>1.0</priority></url>",
    f"  <url><loc>{h(ORIGIN)}/ying/</loc><lastmod>{today}</lastmod><priority>0.6</priority></url>",
  ]
  for vid in volumes:
    vq = quote(vid, safe="")
    urls.append(
      f"  <url><loc>{h(ORIGIN)}/v/{vq}/</loc>"
      f"<lastmod>{today}</lastmod><priority>0.9</priority></url>"
    )
  for item in items:
    aid = quote(item["id"], safe="")
    urls.append(
      f"  <url><loc>{h(ORIGIN)}/a/{aid}/</loc>"
      f"<lastmod>{today}</lastmod><priority>0.8</priority></url>"
    )
  xml = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + "\n".join(urls)
    + "\n</urlset>\n"
  )
  (SITE / "sitemap.xml").write_text(xml, encoding="utf-8")


def main() -> None:
  books = json.loads((SITE / "data" / "books.json").read_text(encoding="utf-8"))
  items = flatten_books(books)
  index_html = (SITE / "index.html").read_text(encoding="utf-8")
  # 复用首页引用的 css 版本，保证聚合页与其余页样式一致、同步破缓存
  m = re.search(r'href="(css/app\.css[^"]*)"', index_html)
  css_link = m.group(1) if m else "css/app.css"
  volumes = write_volume_pages(books, css_link)
  if OUT_DIR.exists():
    shutil.rmtree(OUT_DIR)
  OUT_DIR.mkdir(parents=True)
  total = len(items)
  for i, item in enumerate(items):
    aid = item["id"]
    art = json.loads((ARTICLE_DIR / f"{aid}.json").read_text(encoding="utf-8"))
    url = f"{ORIGIN}/a/{quote(aid, safe='')}/"
    prev = items[i - 1] if i > 0 else None
    nxt = items[i + 1] if i < total - 1 else None
    out = OUT_DIR / aid / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page_html(index_html, art, url, prev, nxt), encoding="utf-8")
  write_sitemap(items, volumes)
  (SITE / "robots.txt").write_text(
    f"User-agent: *\nAllow: /\n\nSitemap: {ORIGIN}/sitemap.xml\n",
    encoding="utf-8",
  )
  print(
    f"Generated {len(items)} article pages under {OUT_DIR.relative_to(ROOT)} "
    f"and {len(volumes)} volume index pages under {VOL_DIR.relative_to(ROOT)}"
  )


if __name__ == "__main__":
  main()
