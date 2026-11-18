#!/usr/bin/env python3
"""Regenerate the full article-link section of site/geo/llms-full.txt.

The hand-verified head of that file (volumes section + all 621 questions)
is kept verbatim. This script only refreshes the appended section
"## 文钞正文逐篇链接", listing every article from the same data source
the page builder uses (books.json + site/data/articles/*.json), grouped
by volume, so the file never goes stale when articles are added.

It never touches any main-site page: its only outputs are
site/geo/llms-full.txt and this script itself. Re-running it is
idempotent: the appended section is replaced, not duplicated.

Usage: python3 scripts/build_geo_llms.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_article_pages import ARTICLE_DIR, ORIGIN, SITE, article_path, flatten_books  # noqa: E402

GEO_LLMS = SITE / "geo" / "llms-full.txt"
SECTION_MARKER = "## 文钞正文逐篇链接"
OLD_INTRO_NOTE = (
    "完整文章清单见 https://wenchao.foyue.org/sitemap.xml"
    "（本文档列出全部书目、主题与全部 621 问；"
    "文钞正文 2565 篇的逐篇链接建议由构建脚本在部署时"
    "从同一数据源生成并追加，见部署说明）。"
)
NEW_INTRO_NOTE = (
    "完整文章清单见 https://wenchao.foyue.org/sitemap.xml；"
    "文钞正文逐篇链接见文末“文钞正文逐篇链接”一节，"
    "由 scripts/build_geo_llms.py 从同一数据源"
    "（books.json 与文章数据）自动生成。"
)


def main() -> None:
    books = json.loads((SITE / "data" / "books.json").read_text(encoding="utf-8"))
    items = flatten_books(books)

    lines: list[str] = [SECTION_MARKER, ""]
    lines.append(
        "下表由 scripts/build_geo_llms.py 从 books.json 与文章数据自动生成，"
        "与站内文章页一一对应；标题与页面标题一致。"
    )
    lines.append("")
    current_vol = None
    article_count = 0
    missing_pages: list[str] = []
    for item in items:
        aid = item["id"]
        vol = item.get("_volumeName", "")
        if vol != current_vol:
            current_vol = vol
            if article_count > 0:
                lines.append("")
            lines.append(f"### {vol}")
            lines.append("")
        art_path = ARTICLE_DIR / f"{aid}.json"
        try:
            art = json.loads(art_path.read_text(encoding="utf-8"))
            title = (art.get("title") or "").strip() or aid
        except OSError:
            title = aid
        url = f"{ORIGIN}{article_path(aid)}"
        lines.append(f"- [{title}]({url})")
        article_count += 1
        if not (SITE / "a" / quote(aid, safe="") / "index.html").exists():
            missing_pages.append(aid)
    # remove trailing blank grouping artifacts: keep one blank line at end
    text = "\n".join(lines).rstrip() + "\n"

    if missing_pages:
        print(f"WARNING: {len(missing_pages)} articles lack a built page, "
              f"first few: {missing_pages[:5]}")

    old = GEO_LLMS.read_text(encoding="utf-8")
    if OLD_INTRO_NOTE in old:
        old = old.replace(OLD_INTRO_NOTE, NEW_INTRO_NOTE)
    if SECTION_MARKER in old:
        head = old.split(SECTION_MARKER, 1)[0].rstrip() + "\n\n"
    else:
        head = old.rstrip() + "\n\n"
    GEO_LLMS.write_text(head + text, encoding="utf-8")
    print(f"wrote {GEO_LLMS} with {article_count} article links "
          f"across {len(books)} volumes")


if __name__ == "__main__":
    main()
