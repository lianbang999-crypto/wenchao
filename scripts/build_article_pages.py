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
ORIGIN = os.environ.get("SITE_ORIGIN", "https://wenchao.foyue.org").rstrip("/")


def h(value: object) -> str:
  return html.escape(str(value or ""), quote=True)


def clean_text(value: str) -> str:
  value = re.sub(r"\[\d{1,3}\]", "", value or "")
  return re.sub(r"\s+", " ", value).strip()


def clip(value: str, n: int) -> str:
  value = clean_text(value)
  return value if len(value) <= n else value[: n - 1].rstrip() + "…"


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


def prerender_main(art: dict) -> str:
  crumb = " · ".join(
    x for x in [
      art.get("volumeName", ""),
      art.get("juan", ""),
      art.get("category", ""),
      art.get("translator", ""),
    ] if x
  )
  mode = "orig" if art.get("plain") else "both"
  lines = [
    '<main class="reader" id="reader">',
    '  <div class="reader-inner seo-prerender">',
    '    <header class="art-head">',
    f'      <div class="art-crumb">{h(crumb)}</div>',
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
  notes = notes_for(art)
  if notes:
    lines.append(f'    {notes}')
  lines.extend([
    '  </div>',
    '</main>',
  ])
  return "\n".join(lines)


def page_html(index_html: str, art: dict, url: str) -> str:
  title = f'{art.get("title", "")} · 印光法师文钞'
  desc = description_for(art)
  doc = index_html
  if "<base " not in doc:
    doc = doc.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<base href="/">', 1)
  doc = re.sub(r"<title>.*?</title>", f"<title>{h(title)}</title>", doc, count=1, flags=re.S)
  desc_meta = f'<meta name="description" content="{h(desc)}">'
  doc = re.sub(r'<meta name="description" content="[^"]*">', desc_meta, doc, count=1)
  seo = (
    f'\n<link rel="canonical" href="{h(url)}">'
    f'\n<meta property="og:type" content="article">'
    f'\n<meta property="og:title" content="{h(title)}">'
    f'\n<meta property="og:description" content="{h(desc)}">'
    f'\n<meta property="og:url" content="{h(url)}">'
  )
  doc = doc.replace(desc_meta, desc_meta + seo, 1)
  marker = '<main class="reader" id="reader"></main>'
  if marker not in doc:
    raise RuntimeError("site/index.html reader placeholder not found")
  return doc.replace(marker, prerender_main(art), 1)


def write_sitemap(items: list[dict]) -> None:
  today = dt.date.today().isoformat()
  urls = [
    f"  <url><loc>{h(ORIGIN)}/</loc><lastmod>{today}</lastmod><priority>1.0</priority></url>"
  ]
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
  if OUT_DIR.exists():
    shutil.rmtree(OUT_DIR)
  OUT_DIR.mkdir(parents=True)
  for item in items:
    aid = item["id"]
    art = json.loads((ARTICLE_DIR / f"{aid}.json").read_text(encoding="utf-8"))
    url = f"{ORIGIN}/a/{quote(aid, safe='')}/"
    out = OUT_DIR / aid / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page_html(index_html, art, url), encoding="utf-8")
  write_sitemap(items)
  (SITE / "robots.txt").write_text(
    f"User-agent: *\nAllow: /\n\nSitemap: {ORIGIN}/sitemap.xml\n",
    encoding="utf-8",
  )
  print(f"Generated {len(items)} article pages under {OUT_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
  main()
