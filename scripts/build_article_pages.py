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
TOPIC_DIR = SITE / "t"
ORIGIN = os.environ.get("SITE_ORIGIN", "https://wenchao.foyue.org").rstrip("/")
SITE_NAME = "印光法师文钞"
AUTHOR = "印光法师"
QNUM_RE = re.compile(r'^\d+[、.]')   # q600 题号正则，与 build_faq_schema.py 同口径


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


def source_line_html(art: dict) -> str:
  """篇末「本篇出自 · 某分册」一行。

  篇首那行位置信息已按设计隐去（所在分册在左侧目录可见，标题上方再挂一行是噪音），
  但它同时是通往分册枢纽的站内链，而隐藏元素的链接权重会被搜索引擎打折。
  故在篇末留一处可见的同等链接：读者读完正好承接「回到本册」，权重也不丢。
  """
  vid, vname = art.get("volume", ""), art.get("volumeName", "")
  if not (vid and vname):
    return ""
  juan = short_juan(art.get("juan", ""))
  tail = f' · {h(juan)}' if juan and juan != vname else ""
  return (f'<p class="art-source">本篇出自 '
          f'<a href="{vol_path(vid)}">{h(vname)}</a>{tail}</p>')


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
  for extra in (xuandu_html(art), notes_for(art), backrefs_html(art),
                source_line_html(art), artnav_html(prev, nxt)):
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
    f'{faq_ld(art)}'
  )
  doc = doc.replace(desc_meta, desc_meta + seo, 1)
  marker = '<main class="reader" id="reader"></main>'
  if marker not in doc:
    raise RuntimeError("site/index.html reader placeholder not found")
  return doc.replace(marker, prerender_main(art, prev, nxt), 1)


def faq_ld(art: dict) -> str:
  """《答念佛600问》每篇本身就是一问一答，补 FAQPage 结构化数据，
  搜索结果可展开问答富摘要；AI 引擎也更容易据此直接取答。

  只认篇名以题号开头的（如「1、…」），卷首传记之类跳过。
  答案优先取白话，无白话则取原文，截到 ANS_MAX 字。

  注：本站曾有独立的 build_faq_schema.py 事后往 HTML 里补注，但本脚本每次
  会清空重建 site/a/，那份补注一重建就没了——故直接在此随页面一起生成。
  """
  title = art.get("title", "")
  if not QNUM_RE.match(title):
    return ""
  ANS_MAX = 800
  parts: list[str] = []
  if art.get("summary"):
    parts.append(clean_text(art["summary"]))
  for seg in art.get("segments", []):
    for p in (seg.get("trans") or seg.get("orig") or []):
      t = clean_text(p)
      if t:
        parts.append(t)
    if sum(len(x) for x in parts) >= ANS_MAX:
      break
  answer = " ".join(parts)[:ANS_MAX].rstrip()
  if not answer:
    return ""
  data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [{
      "@type": "Question",
      "name": title,
      "acceptedAnswer": {"@type": "Answer", "text": answer},
    }],
  }
  raw = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
  return f'\n<script type="application/ld+json">{raw}</script>'


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
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="192x192" href="/img/icons/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="印祖文钞">
<!-- 字体走同源自托管（与首页/文章页同一套 css/fonts.css）。原先此处是 Google Fonts +
     jsdelivr 双外链：大陆常被阻断、render-blocking，且开了 Cloudflare Fonts 后会被改写成
     每页 277KB 的内联 @font-face 表。字族名（Noto Serif SC / LXGW WenKai GB Screen）一致。 -->
<link rel="stylesheet" href="{h(css_link.replace('app.css', 'fonts.css'))}">
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


# ───────────────────────────── 主题专题页 ─────────────────────────────
# 按关键词把全集文章归入通俗主题，生成 /t/{slug}/ 静态聚合页：
# 既作长尾 SEO 枢纽，也方便读者按困惑（念佛/临终/因果…）直接找文。
# 纯静态、不引 app.js，风格比照分册页 /v/。
TOPICS = [
  {"slug": "nianfo", "name": "念佛法门",
   "blurb": "如何念佛、持名的方法与用心——都摄六根、净念相继，一句佛号绵密不断。",
   "kw": ["念佛", "持名", "名号", "佛号", "执持名号", "都摄六根",
          "净念相继", "十念", "摄心", "一句佛"]},
  {"slug": "xinyuan", "name": "信愿往生",
   "blurb": "真信切愿、求生西方——净土法门的宗要与往生正因。",
   "kw": ["信愿", "真信", "切愿", "求生西方", "求生净土", "往生西方",
          "愿生", "深信", "决定往生", "带业往生"]},
  {"slug": "linzhong", "name": "临终助念",
   "blurb": "临终一念与助念之法——命终关头如何护持正念、成就往生。",
   "kw": ["临终", "助念", "命终", "临命终", "临终一念", "断气", "咽气",
          "中阴", "送终", "临终关怀"]},
  {"slug": "yinguo", "name": "因果报应",
   "blurb": "深信因果、明辨罪福——三世因果与断恶修善之理。",
   "kw": ["因果", "报应", "果报", "罪福", "善恶", "三世因果", "阴德",
          "报应不爽", "祸福"]},
  {"slug": "jiesha", "name": "戒杀护生",
   "blurb": "戒杀放生、茹素护生——长养慈心、消解宿世冤业。",
   "kw": ["戒杀", "护生", "放生", "吃素", "素食", "食肉", "杀生",
          "断肉", "蔬食", "茹素", "冤业"]},
  {"slug": "dunlun", "name": "敦伦尽分·家庭教育",
   "blurb": "敦伦尽分、教子治家——在家庭伦常中修行，因果母教并重。",
   "kw": ["敦伦", "尽分", "教子", "治家", "夫妇", "教女", "胎教",
          "母教", "儿女", "为人子", "尽伦", "相夫", "家庭教育"]},
  {"slug": "chengjing", "name": "持戒诚敬",
   "blurb": "诚敬存心、持戒惜福——一分诚敬得一分利益，主敬存诚。",
   "kw": ["诚敬", "恭敬", "至诚", "持戒", "三皈", "五戒", "竭诚",
          "礼敬", "主敬存诚", "惜福", "敬惜字纸"]},
  {"slug": "guanyin", "name": "观音感应",
   "blurb": "观世音菩萨寻声救苦——念观音的用心与真实感应。",
   "kw": ["观世音", "观音", "大士", "寻声救苦", "普门", "念观音",
          "观音感应", "菩萨加被"]},
]

TOPIC_INCLUDE = 6     # 计入某主题的最低权重
TOPIC_CAP = 120       # 每个专题页最多列出的篇数（按相关度取前 N）


def classify_topics(art: dict) -> dict:
  """给一篇文章按各主题打分：标题命中权重最高，摘要次之，正文最低。"""
  title = clean_text(art.get("title", "") or "")
  summary = clean_text(art.get("summary", "") or "")
  parts: list[str] = []
  for seg in art.get("segments", []) or []:
    for key in ("orig", "trans"):
      v = seg.get(key)
      if isinstance(v, list):
        parts.extend(v)
      elif v:
        parts.append(v)
  body = clean_text(" ".join(parts))
  scores: dict[str, int] = {}
  for t in TOPICS:
    s = 0
    for kw in t["kw"]:
      s += 8 * title.count(kw) + 4 * summary.count(kw) + body.count(kw)
    if s:
      scores[t["slug"]] = s
  return scores


def _hub_head(title_full: str, desc: str, url: str, css_link: str, *ld_blocks: str) -> str:
  """分册页/专题页共用的 <head>（含字体、图标、OG、结构化数据）。"""
  ld = "\n".join(b for b in ld_blocks if b)
  return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<base href="/">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{h(title_full)}</title>
<meta name="description" content="{h(desc)}">
<link rel="canonical" href="{h(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{h(title_full)}">
<meta property="og:description" content="{h(desc)}">
<meta property="og:url" content="{h(url)}">
<meta property="og:site_name" content="印光法师文钞">
<meta property="og:locale" content="zh_CN">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="{h(title_full)}">
<meta name="twitter:description" content="{h(desc)}">
<meta name="theme-color" content="#f6f1e6">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="192x192" href="/img/icons/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="印祖文钞">
<!-- 字体走同源自托管（与首页/文章页同一套 css/fonts.css）。原先此处是 Google Fonts +
     jsdelivr 双外链：大陆常被阻断、render-blocking，且开了 Cloudflare Fonts 后会被改写成
     每页 277KB 的内联 @font-face 表。字族名（Noto Serif SC / LXGW WenKai GB Screen）一致。 -->
<link rel="stylesheet" href="{h(css_link.replace('app.css', 'fonts.css'))}">
<link rel="stylesheet" href="{h(css_link)}">
{ld}
</head>"""


def topic_page_html(topic: dict, rows_items: list[dict], css_link: str) -> str:
  """单个主题的纯静态聚合页：按分册分组列出该主题相关篇目。"""
  slug = topic["slug"]
  name = topic["name"]
  blurb = topic["blurb"]
  url = f"{ORIGIN}/t/{quote(slug, safe='')}/"
  count = len(rows_items)
  desc = clip(f"{blurb} 印光法师文钞中论及「{name}」的篇章精选，共 {count} 篇，文白对照。", 150)

  groups: dict[str, list] = {}
  for it in rows_items:
    groups.setdefault(it["volumeName"] or "文钞", []).append(it)
  rows: list[str] = []
  for vname, arts in groups.items():
    rows.append(f'<h2 class="vi-juan">{h(vname)}</h2>')
    for it in arts:
      rows.append(
        f'<a class="vi-link" href="{article_path(it["id"])}">{h(nav_title(it["title"]))}</a>'
      )
  index_body = "\n      ".join(rows)

  others = "".join(
    f'<a href="/t/{quote(o["slug"], safe="")}/">{h(o["name"])}</a>'
    for o in TOPICS if o["slug"] != slug
  )

  breadcrumb = _ld({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": ORIGIN + "/"},
      {"@type": "ListItem", "position": 2, "name": "专题", "item": ORIGIN + "/t/"},
      {"@type": "ListItem", "position": 3, "name": name, "item": url},
    ],
  })
  collection = _ld({
    "@context": "https://schema.org", "@type": "CollectionPage",
    "name": f"{name} · {SITE_NAME}", "url": url, "description": blurb,
    "inLanguage": "zh-Hans",
    "isPartOf": {"@type": "WebSite", "name": SITE_NAME, "url": ORIGIN + "/"},
  })
  head = _hub_head(f"{name} · 印光法师文钞", desc, url, css_link, breadcrumb, collection)
  return f"""{head}
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
    <nav class="crumb-nav"><a href="/">印光法师文钞</a> › <a href="/t/">专题</a> › <span aria-current="page">{h(name)}</span></nav>
    <header class="art-head">
      <div class="art-crumb">专题 · 共 {count} 篇</div>
      <h1 class="art-title">{h(name)}</h1>
      <p class="art-summary">{h(blurb)}</p>
      <div class="rule"></div>
    </header>
    <div class="vol-index">
      {index_body}
    </div>
    <nav class="vol-others">
      <h3>其余专题</h3>
      {others}
      <a href="/t/">全部专题 »</a>
    </nav>
  </div>
</main>
</body>
</html>
"""


def topic_index_html(meta: dict, css_link: str) -> str:
  """/t/ 专题总览页：列出全部主题、导语与篇数，作专题枢纽。"""
  url = f"{ORIGIN}/t/"
  desc = clip("按主题浏览印光法师文钞：念佛、信愿往生、临终助念、因果、戒杀护生、家庭教育、持戒诚敬、观音感应，随困惑找文。", 150)
  cards: list[str] = []
  for t in TOPICS:
    name, cnt, _lm = meta[t["slug"]]
    # 极简条目：题名与篇数一行对齐，导语单行截断（长描述堆三行会把八个专题拉成长页）
    cards.append(
      f'<a class="topic-row" href="/t/{quote(t["slug"], safe="")}/">'
      f'<span class="tr-head"><span class="tr-name">{h(name)}</span>'
      f'<span class="tr-n">{cnt} 篇</span></span>'
      f'<span class="tr-blurb">{h(t["blurb"])}</span></a>'
    )
  index_body = "\n      ".join(cards)
  breadcrumb = _ld({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": SITE_NAME, "item": ORIGIN + "/"},
      {"@type": "ListItem", "position": 2, "name": "专题", "item": url},
    ],
  })
  collection = _ld({
    "@context": "https://schema.org", "@type": "CollectionPage",
    "name": f"专题 · {SITE_NAME}", "url": url, "inLanguage": "zh-Hans",
    "isPartOf": {"@type": "WebSite", "name": SITE_NAME, "url": ORIGIN + "/"},
  })
  head = _hub_head("专题 · 印光法师文钞", desc, url, css_link, breadcrumb, collection)
  return f"""{head}
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
    <nav class="crumb-nav"><a href="/">印光法师文钞</a> › <span aria-current="page">专题</span></nav>
    <header class="art-head">
      <div class="art-crumb">按困惑找文</div>
      <h1 class="art-title">专题浏览</h1>
      <div class="rule"></div>
    </header>
    <div class="vol-index">
      {index_body}
    </div>
  </div>
</main>
</body>
</html>
"""


def write_topic_pages(topic_hits: dict, css_link: str) -> dict:
  """写出全部 /t/{slug}/ 专题页与 /t/ 总览页，返回 {slug: (name, count, lastmod)}。"""
  if TOPIC_DIR.exists():
    shutil.rmtree(TOPIC_DIR)
  TOPIC_DIR.mkdir(parents=True)
  meta: dict = {}
  for t in TOPICS:
    hits = sorted(topic_hits[t["slug"]], key=lambda x: -x[0])[:TOPIC_CAP]
    rows_items = [{"id": aid, "title": title, "volumeName": vn} for (_s, aid, title, vn) in hits]
    dates: list[str] = []
    for it in rows_items:
      p = ARTICLE_DIR / f'{it["id"]}.json'
      try:
        dates.append(dt.date.fromtimestamp(p.stat().st_mtime).isoformat())
      except OSError:
        pass
    lm = max(dates) if dates else dt.date.today().isoformat()
    out = TOPIC_DIR / t["slug"] / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(topic_page_html(t, rows_items, css_link), encoding="utf-8")
    meta[t["slug"]] = (t["name"], len(rows_items), lm)
  (TOPIC_DIR / "index.html").write_text(topic_index_html(meta, css_link), encoding="utf-8")
  return meta


def write_sitemap(items: list[dict], volumes: list[str], topics: dict | None = None) -> None:
  today = dt.date.today().isoformat()
  # lastmod 取文章数据文件的真实 mtime（内容没变则日期不动），
  # 避免每次构建都把整站刷成当天、误导爬虫以为天天全量更新。
  art_dates: dict[str, str] = {}
  for item in items:
    aid = item["id"]
    p = ARTICLE_DIR / f"{aid}.json"
    try:
      art_dates[aid] = dt.date.fromtimestamp(p.stat().st_mtime).isoformat()
    except OSError:
      art_dates[aid] = today
  # 分册页取该册文章的最新 mtime；首页/影像页取全站最新。
  vol_dates: dict[str, str] = {}
  for aid, d in art_dates.items():
    vid = aid.rsplit("-", 1)[0]
    if d > vol_dates.get(vid, ""):
      vol_dates[vid] = d
  newest = max(art_dates.values(), default=today)
  urls = [
    f"  <url><loc>{h(ORIGIN)}/</loc><lastmod>{newest}</lastmod><priority>1.0</priority></url>",
    f"  <url><loc>{h(ORIGIN)}/ying/</loc><lastmod>{newest}</lastmod><priority>0.6</priority></url>",
    # 「问文钞」独立页此前一直漏在站点地图外，从未被提交收录
    f"  <url><loc>{h(ORIGIN)}/ask/</loc><lastmod>{newest}</lastmod><priority>0.9</priority></url>",
  ]
  for vid in volumes:
    vq = quote(vid, safe="")
    lm = vol_dates.get(vid, newest)
    urls.append(
      f"  <url><loc>{h(ORIGIN)}/v/{vq}/</loc>"
      f"<lastmod>{lm}</lastmod><priority>0.9</priority></url>"
    )
  if topics:
    topic_newest = max((lm for (_n, _c, lm) in topics.values()), default=newest)
    urls.append(
      f"  <url><loc>{h(ORIGIN)}/t/</loc>"
      f"<lastmod>{topic_newest}</lastmod><priority>0.8</priority></url>"
    )
    for slug, (_name, _cnt, lm) in topics.items():
      tq = quote(slug, safe="")
      urls.append(
        f"  <url><loc>{h(ORIGIN)}/t/{tq}/</loc>"
        f"<lastmod>{lm}</lastmod><priority>0.8</priority></url>"
      )
  for item in items:
    aid = quote(item["id"], safe="")
    lm = art_dates.get(item["id"], newest)
    urls.append(
      f"  <url><loc>{h(ORIGIN)}/a/{aid}/</loc>"
      f"<lastmod>{lm}</lastmod><priority>0.8</priority></url>"
    )
  xml = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + "\n".join(urls)
    + "\n</urlset>\n"
  )
  (SITE / "sitemap.xml").write_text(xml, encoding="utf-8")



def sync_page_versions(css_link: str) -> list:
  """把外壳版本串同步进独立静态页（/ying/、/ask/）的带版本资源引用。
  这些页不由本脚本生成，版本串曾长期落后；统一后 _headers 才能放心给
  css/js 设 immutable 长缓存。"""
  m = re.search(r"v=([\w-]+)", css_link)
  if not m:
    return []
  ver = m.group(1)
  synced = []
  for rel in ("ying/index.html", "ask/index.html"):
    fp = SITE / rel
    if not fp.exists():
      continue
    doc = fp.read_text(encoding="utf-8")
    # 覆盖所有带版本串直引的资源。漏一个就会在 /js/* immutable 下被缓存一年：
    # pwa.js / offline.js / config.js 曾各自停在旧版本串上，正是这么漏的。
    out = re.sub(
      r"((?:css/app\.css|css/fonts\.css|js/app\.js|js/share\.js|js/ask\.js"
      r"|js/pwa\.js|js/offline\.js|config\.js)\?v=)[\w.-]+",
      lambda mm: mm.group(1) + ver, doc)
    if out != doc:
      fp.write_text(out, encoding="utf-8")
      synced.append(rel)
  return synced


HOME_HERO = (
  '<div class="home-hero"><span class="v-sub">文白对照 · 闻思修学</span>'
  '<h1 class="v-title" style="margin:0">印光法师文钞</h1>'
  '<span class="seal" aria-hidden="true">文钞</span></div>'
)
HOME_NOTE = (
  '<p class="home-note">底本为《印光法师文钞》增广、续编、三编及三编补之文白对照本。'
  '文言原文与白话译文逐篇对照排录；正文中带朱点之词语，点按可查名相注释。<br>愿见闻者，同沾法益。</p>'
)


def prerender_home(index_html: str, books: list) -> str:
  """把首页书架预渲染进 index.html 的 #reader：百度等不执行 JS 的爬虫也能收录首页内容，
  分册卡用 <a href="/v/…/">（可循链）；运行时 app.js renderHome 以同样式重绘并接管交互。"""
  total = 0
  cards = []
  # 分册标签位：与 app.js 的 STARTER_VOLS 同口径，留空即不挂标签
  starter: dict[str, str] = {}
  for vol in books:
    count = sum(len(c["items"]) for j in vol["juans"] for c in j["cats"])
    total += count
    tag = f'<span class="vol-tag">{starter[vol["id"]]}</span>' if vol["id"] in starter else ""
    cards.append(
      f'<a class="vol-card" href="/v/{h(vol["id"])}/">'
      f'<span class="vol-name">{h(vol["name"])}</span>{tag}'
      f'<span class="vol-group">{h(vol.get("group", ""))}</span>'
      f'<span class="vol-count">{count} 篇</span></a>'
    )
  inner = (
    '<div class="home">' + HOME_HERO +
    f'<h2>{len(books)} 部 · 共 {total} 篇</h2>' + "".join(cards) +
    '<div class="home-extra"><a class="home-cta" href="/ying/">瞻礼 · 印祖法相与传印长老题词 →</a>'
    '<a class="home-cta" href="https://foyue.org/">佛乐 · 返回净土法音主站 →</a></div>' +
    HOME_NOTE + '</div>'
  )
  marker = '<main class="reader" id="reader"></main>'
  return index_html.replace(marker, f'<main class="reader" id="reader">{inner}</main>', 1)


def main() -> None:
  books = json.loads((SITE / "data" / "books.json").read_text(encoding="utf-8"))
  items = flatten_books(books)
  index_html = (SITE / "index.html").read_text(encoding="utf-8")
  # 剥掉上次构建注入的首页预渲染内容，恢复空壳占位符（幂等；文章页模板始终从空壳出发）
  index_html = re.sub(r'(<main class="reader" id="reader">).*?(</main>)',
                      r"\1\2", index_html, count=1, flags=re.S)
  # 复用首页引用的 css 版本，保证聚合页与其余页样式一致、同步破缓存
  m = re.search(r'href="(css/app\.css[^"]*)"', index_html)
  css_link = m.group(1) if m else "css/app.css"
  volumes = write_volume_pages(books, css_link)
  if OUT_DIR.exists():
    shutil.rmtree(OUT_DIR)
  OUT_DIR.mkdir(parents=True)
  total = len(items)
  topic_hits: dict = {t["slug"]: [] for t in TOPICS}
  for i, item in enumerate(items):
    aid = item["id"]
    art = json.loads((ARTICLE_DIR / f"{aid}.json").read_text(encoding="utf-8"))
    url = f"{ORIGIN}/a/{quote(aid, safe='')}/"
    prev = items[i - 1] if i > 0 else None
    nxt = items[i + 1] if i < total - 1 else None
    out = OUT_DIR / aid / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page_html(index_html, art, url, prev, nxt), encoding="utf-8")
    # 顺带按主题归类（复用已加载的 art，避免二次读盘）
    vn = art.get("volumeName", "") or item.get("_volumeName", "")
    for slug, score in classify_topics(art).items():
      if score >= TOPIC_INCLUDE:
        topic_hits[slug].append((score, aid, art.get("title", ""), vn))
  topics_meta = write_topic_pages(topic_hits, css_link)
  write_sitemap(items, volumes, topics_meta)
  (SITE / "robots.txt").write_text(
    f"User-agent: *\nAllow: /\n\nSitemap: {ORIGIN}/sitemap.xml\n",
    encoding="utf-8",
  )
  (SITE / "index.html").write_text(prerender_home(index_html, books), encoding="utf-8")
  synced = sync_page_versions(css_link)
  print(
    f"Generated {len(items)} article pages under {OUT_DIR.relative_to(ROOT)}, "
    f"{len(volumes)} volume pages under {VOL_DIR.relative_to(ROOT)}, "
    f"and {len(topics_meta)} topic pages under {TOPIC_DIR.relative_to(ROOT)}; "
    f"home prerendered" + (f", versions synced: {', '.join(synced)}" if synced else "")
  )


if __name__ == "__main__":
  main()
