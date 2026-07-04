# -*- coding: utf-8 -*-
"""
《印光法师答念佛600问》docx → 站点数据 构建器（自包含）

源文件全是文言文。本书**只保留原文**，不做文白对照、不配白话。本脚本：
  1. 解析 docx：跳过 Word 目录(TOC)与页眉噪声；按 卷 / 章 / 问 三级切分，
     卷首传记《中兴净宗印光大师行业记》单独收为「卷首」一篇。
     题目判定：行首匹配 `^\\d+、` 且编号 == 上一题+1（编号连续性兜底，
     不依赖样式/粗体——部分题目用 Heading 1 样式得粗、run.bold 为空）。
  2. 每问：开头连续粗体段 → summary（提要，印祖原话浓缩，原文呈现）；
     其后文钞引文段 → segments（trans 恒为空，只显原文）；段尾/独立成段的
     `（《新编全本…》卷X第Y页 篇名）` 抽出为该段 src（出处保留）。
  3. 产出：site/data/articles/q600-*.json + 追加 books.json 的 q600 部
     + scripts/report_600.md（仅记编号告警）。

铁律（继承 values.md / 项目铁律）：只切分不改字；不 AI 翻译；异常入报告人工复核。
用法：python3 scripts/build_600.py
"""
import json
import os
import re

import docx

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(PROJ, "印祖文钞", "《印光法师答念佛600问》原文.docx")
DATA = os.path.join(PROJ, "site", "data")
ART = os.path.join(DATA, "articles")
BOOKS = os.path.join(DATA, "books.json")
REPORT = os.path.join(PROJ, "scripts", "report_600.md")

VOL_ID = "q600"
VOL_NAME = "印光法师答念佛600问"
VOL_GROUP = "净土问答 · 文钞辑录"

# 页眉/版式噪声段（整段等于这些字样即丢弃）
NOISE = {
    "印光法师答念佛600问", "印光法师念佛600问",
    "净土宗第十三祖师印光法师德相", "目录",
}
BIO_TITLE = "中兴净宗印光大师行业记"

JUAN_RE = re.compile(r'^卷[一二三四五六七八九十]')
CHAP_RE = re.compile(r'^第[一二三四五六七八九十百零]+章')
QNUM_RE = re.compile(r'^(\d+)、')
SRC_TAIL_RE = re.compile(r'（《[^》]+》[^）]*）\s*$')


def is_run_bold(p) -> bool:
    return any(r.bold for r in p.runs if r.text.strip())


def norm_title(s: str) -> str:
    # "卷一  净土法门的缘起" → "卷一 · 净土法门的缘起"
    return re.sub(r'\s{2,}', ' · ', s.strip())


def strip_src(t: str):
    """剥离段尾出处串，返回 (正文, 出处|None)。"""
    m = SRC_TAIL_RE.search(t)
    if m:
        return t[:m.start()].strip(), m.group(0).strip()
    return t, None


# ---------------- 解析 docx → 块 ----------------
def parse_blocks(paras):
    last_toc = max(i for i, p in enumerate(paras)
                   if p.style and 'toc' in p.style.name.lower())
    blocks = []           # 问块：{'kind':'q','juan','cat','num','title','paras':[]}
    bio = None            # 卷首传记块
    cur = None            # 当前承接段落的块
    cur_juan = cur_cat = None
    last_num = 0
    report_lines = []

    for p in paras[last_toc + 1:]:
        t = p.text.strip()
        if not t or t in NOISE or t.isdigit():
            continue
        if t == BIO_TITLE:
            bio = {'kind': 'bio', 'title': t, 'paras': []}
            cur = bio
            continue
        if JUAN_RE.match(t) and len(t) < 30:
            cur_juan = norm_title(t)
            cur_cat = None
            cur = None
            continue
        if CHAP_RE.match(t) and len(t) < 40:
            cur_cat = norm_title(t)
            cur = None
            continue
        m = QNUM_RE.match(t)
        if m:
            n = int(m.group(1))
            if n == last_num + 1:
                last_num = n
                cur = {'kind': 'q', 'juan': cur_juan, 'cat': cur_cat,
                       'num': n, 'title': t, 'paras': []}
                blocks.append(cur)
                continue
            else:
                report_lines.append(f"- ⚠️ 非连续编号 {n}（上一题 {last_num}）：{t[:40]}")
        if cur is not None:
            cur['paras'].append(p)
    return bio, blocks, last_num, report_lines


# ---------------- 块 → 文章 JSON ----------------
def build_bio_article(bio):
    segs = []
    for p in bio['paras']:
        t = p.text.strip()
        if not t or t in NOISE or t.isdigit():
            continue
        body, _src = strip_src(t)
        if body:
            segs.append({'orig': [body], 'trans': [], 'notes': []})
    return {
        'id': f'{VOL_ID}-000', 'volume': VOL_ID, 'volumeName': VOL_NAME,
        'juan': '卷首', 'category': '', 'title': bio['title'],
        'translator': '', 'summary': '', 'segments': segs, 'anomalies': [],
    }


def build_q_article(block):
    paras = block['paras']
    # 提要：开头连续 run-bold 段
    summary_parts, k = [], 0
    while k < len(paras) and is_run_bold(paras[k]):
        body, _src = strip_src(paras[k].text.strip())
        if body:
            summary_parts.append(body)
        k += 1
    summary = ' '.join(summary_parts).strip()

    segments = []
    for p in paras[k:]:
        t = p.text.strip()
        if not t or t in NOISE or t.isdigit():
            continue
        body, src = strip_src(t)
        if not body:
            # 独立成段的出处行 → 附到上一段
            if src and segments:
                segments[-1]['src'] = src
            continue
        seg = {'orig': [body], 'trans': [], 'notes': []}   # 只保留原文，不配白话
        if src:
            seg['src'] = src
        segments.append(seg)

    juan = block['juan'] or '卷首'
    cat = block['cat']
    art = {
        'id': f"{VOL_ID}-{block['num']:03d}", 'volume': VOL_ID, 'volumeName': VOL_NAME,
        'juan': juan, 'category': cat or '', 'title': block['title'],
        'translator': '', 'summary': summary, 'segments': segments, 'anomalies': [],
    }
    return art


# ---------------- books.json 装配 ----------------
def assemble_book(article_meta):
    """article_meta: 有序 list[(juan_name, cat_name_or_None, item_dict)]，构造 q600 部。"""
    juans = []           # [{name, cats:[{name, items:[]}]}]
    juan_idx, cat_idx = {}, {}
    for juan_name, cat_name, item in article_meta:
        cname = cat_name or '正文'
        if juan_name not in juan_idx:
            jobj = {'name': juan_name, 'cats': []}
            juans.append(jobj)
            juan_idx[juan_name] = jobj
            cat_idx[juan_name] = {}
        jobj = juan_idx[juan_name]
        if cname not in cat_idx[juan_name]:
            cobj = {'name': cname, 'items': []}
            jobj['cats'].append(cobj)
            cat_idx[juan_name][cname] = cobj
        cat_idx[juan_name][cname]['items'].append(item)
    return {'id': VOL_ID, 'name': VOL_NAME, 'group': VOL_GROUP, 'juans': juans}


def main():
    print("==> 读取 docx：", os.path.basename(SRC))
    doc = docx.Document(SRC)
    bio, blocks, last_num, report_warn = parse_blocks(doc.paragraphs)
    print(f"   识别问题 {len(blocks)} 个（末号 {last_num}）；卷首传记 {'有' if bio else '无'}")

    article_meta = []      # 有序 (juan, cat, item) 用于 books.json
    total_seg = 0
    written = 0

    # 卷首传记
    if bio:
        a = build_bio_article(bio)
        json.dump(a, open(os.path.join(ART, a['id'] + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))
        written += 1
        total_seg += len(a['segments'])
        article_meta.append(('卷首', None, {
            'id': a['id'], 'title': a['title'], 'paired': False,
            'plain': False, 'notes': 0}))

    # 各问（只保留原文，paired 恒 False）
    for block in blocks:
        a = build_q_article(block)
        json.dump(a, open(os.path.join(ART, a['id'] + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))
        written += 1
        total_seg += len(a['segments'])
        article_meta.append((a['juan'], a['category'] or None, {
            'id': a['id'], 'title': a['title'], 'paired': False,
            'plain': False, 'notes': 0}))

    # books.json：移除旧 q600 后追加
    books = json.load(open(BOOKS, encoding='utf-8'))
    books = [b for b in books if b.get('id') != VOL_ID]
    books.append(assemble_book(article_meta))
    json.dump(books, open(BOOKS, 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    # 报告（只保留原文，无白话配对；仅记编号告警）
    lines = [
        "# 《印光法师答念佛600问》构建报告",
        "",
        "- 底本：全文言原文，只切分不配白话（无文白对照）",
        f"- 问题数：{len(blocks)}（末号 {last_num}）；卷首传记：{'1 篇' if bio else '无'}",
        f"- 写出文章 JSON：{written} 篇 → site/data/articles/{VOL_ID}-*.json",
        f"- 引文段总数：{total_seg}",
        "",
        "## 编号告警",
        *(report_warn or ["- 无"]),
    ]
    open(REPORT, 'w', encoding='utf-8').write("\n".join(lines) + "\n")

    print(f"==> 完成：{written} 篇（只保留原文，共 {total_seg} 段）")
    print(f"   报告 → {os.path.relpath(REPORT, PROJ)}")
    print("   注意：改了 site/data，请给 site/sw.js 的 VER 升号。")


if __name__ == '__main__':
    main()
