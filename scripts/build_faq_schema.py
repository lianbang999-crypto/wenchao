#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/build_faq_schema.py
《印光法师答念佛600问》FAQPage JSON-LD 注入脚本

为 site/a/q600-*/index.html 补注 FAQPage 结构化数据，
使 Google 搜索可展示"问答"富媒体卡片（Rich Results）。

工作方式
────────
  1. 遍历 site/data/articles/q600-*.json（共 621 篇）
  2. 跳过卷首传记（篇名不以数字编号开头的篇目，如 q600-000）
  3. 为每问构造 FAQPage JSON-LD：
       question.name  = 篇名（含题号，如"1、南无阿弥陀佛六字洪名含义是什么？"）
       answer.text    = summary + segments 文本，优先白话（trans），
                        无白话取原文（orig），截至 ANS_MAX 字符
  4. 在 site/a/{id}/index.html 的 </head> 前插入 JSON-LD <script> 标签
  5. 幂等：已含 FAQPage 的页面跳过（可安全重复运行）

前提：先运行 python3 scripts/build_article_pages.py 生成 HTML 文件。

注意：build_article_pages.py 会清空重建 site/a/，故每次重建后需再运行本脚本；
      更稳健的做法是在 build_article_pages.py 的 page_html() 里直接调用
      faq_ld_for()——build_article_pages.py 已同步打好此补丁，见其 faq_ld_for()。

用法
────
  python3 scripts/build_faq_schema.py
"""

import glob
import json
import os
import re

PROJ     = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART_DATA = os.path.join(PROJ, 'site', 'data', 'articles')
ART_HTML = os.path.join(PROJ, 'site', 'a')

ANS_MAX = 800    # 答案文本字符上限（保守值；Google 无硬限但建议简明）
QNUM_RE = re.compile(r'^\d+[、.]')   # 篇名是否以数字题号开头（排除卷首传记）


# ─── 核心函数（同步于 build_article_pages.py faq_ld_for）─────────────────────

def _ws(s: str) -> str:
    """折叠连续空白，去首尾空格。"""
    return re.sub(r'\s+', ' ', (s or '').strip())


def build_answer_text(art: dict) -> str:
    """
    从一篇文章提取 FAQPage answer.text 纯文本：
    · summary 置首
    · segments 按序拼接：有 trans（白话）取 trans，无则取 orig（原文）
    · 截至 ANS_MAX 字符，末尾加省略号
    """
    parts: list[str] = []
    if art.get('summary'):
        parts.append(_ws(art['summary']))
    for seg in art.get('segments', []):
        lines = seg.get('trans') or seg.get('orig', [])
        for line in lines:
            t = _ws(line)
            if t:
                parts.append(t)
    text = ' '.join(parts)
    if len(text) > ANS_MAX:
        text = text[:ANS_MAX - 1].rstrip() + '…'
    return text


def faq_ld_for(art: dict) -> str | None:
    """
    为一篇 q600 文章生成 FAQPage JSON-LD <script> 标签。
    传记等篇名不以数字开头的篇目返回 None。
    """
    title = art.get('title', '')
    if not QNUM_RE.match(title):
        return None
    data = {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        'mainEntity': [{
            '@type': 'Question',
            'name': title,
            'acceptedAnswer': {
                '@type': 'Answer',
                'text': build_answer_text(art),
            },
        }],
    }
    raw = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    raw = raw.replace('<', '\\u003c')   # 防 </script> 截断
    return f'<script type="application/ld+json">{raw}</script>'


# ─── HTML 注入（单文件）─────────────────────────────────────────────────────

def _inject(html_path: str, tag: str) -> str:
    """
    在 html_path 的第一个 </head> 前插入 tag。
    返回: 'injected' | 'present'（已有 FAQPage）| 'no_head'（结构异常）
    """
    with open(html_path, encoding='utf-8') as fh:
        content = fh.read()
    if '"FAQPage"' in content:
        return 'present'
    if '</head>' not in content:
        return 'no_head'
    with open(html_path, 'w', encoding='utf-8') as fh:
        fh.write(content.replace('</head>', tag + '\n</head>', 1))
    return 'injected'


# ─── 主流程 ──────────────────────────────────────────────────────────────────

def main() -> None:
    files = sorted(glob.glob(os.path.join(ART_DATA, 'q600-*.json')))
    print(f'==> 找到 q600 数据文件：{len(files)} 篇')

    injected = present = no_html = skipped = err = 0

    for fpath in files:
        with open(fpath, encoding='utf-8') as fh:
            art = json.load(fh)
        aid = art['id']

        tag = faq_ld_for(art)
        if tag is None:          # 非问答篇（卷首传记等）
            skipped += 1
            continue

        html_path = os.path.join(ART_HTML, aid, 'index.html')
        if not os.path.exists(html_path):
            no_html += 1
            continue

        result = _inject(html_path, tag)
        if   result == 'injected': injected += 1
        elif result == 'present':  present  += 1
        else:
            print(f'  ⚠️  {aid}: 未找到 </head>，跳过')
            err += 1

    # ── 摘要 ────────────────────────────────────────────────────────────────
    parts = [f'注入 {injected} 篇']
    if present: parts.append(f'已有 {present} 篇（幂等跳过）')
    if no_html: parts.append(f'HTML 缺失 {no_html} 篇')
    if skipped: parts.append(f'非问答跳过 {skipped} 篇')
    if err:     parts.append(f'异常 {err} 篇')
    print('==> ' + ' | '.join(parts))

    if no_html:
        print('   ℹ️  HTML 文件缺失，请先运行：python3 scripts/build_article_pages.py')
    if injected:
        print('   ℹ️  HTML 已更新，请给 site/sw.js 的 VER 升号以破除旧 Service Worker 缓存')


if __name__ == '__main__':
    main()
