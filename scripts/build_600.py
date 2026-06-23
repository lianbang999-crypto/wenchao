# -*- coding: utf-8 -*-
"""
《印光法师答念佛600问》docx → 站点数据 构建器（自包含）

源文件全是文言文，无白话。本脚本：
  1. 解析 docx：跳过 Word 目录(TOC)与页眉噪声；按 卷 / 章 / 问 三级切分，
     卷首传记《中兴净宗印光大师行业记》单独收为「卷首」一篇。
     题目判定：行首匹配 `^\\d+、` 且编号 == 上一题+1（编号连续性兜底，
     不依赖样式/粗体——部分题目用 Heading 1 样式得粗、run.bold 为空）。
  2. 每问：开头连续粗体段 → summary（提要，印祖原话浓缩，原文呈现）；
     其后文钞引文段 → segments；段尾/独立成段的 `（《新编全本…》卷X第Y页 篇名）`
     抽出为该段 src。
  3. 引文白话：从本站现有语料（site/data/articles/*.json，排除 jy 嘉言录与自身 q600）
     逐「行」建索引（paired 段内 orig[i]↔trans[i] 已验证逐行对齐）。引文 squash 后
     在语料拼接串中精确子串定位，取覆盖到的各行已出版白话拼接为该段白话；
     未命中则诚实留白（trans:[] 只显原文），并写入 report_600.md 待人工复核。
  4. 产出：site/data/articles/q600-*.json + 追加 books.json 的 q600 部 + scripts/report_600.md

铁律（继承 values.md / 项目铁律）：只切分不改字；不 AI 翻译；异常入报告人工复核。
用法：python3 scripts/build_600.py
"""
import bisect
import glob
import json
import os
import re
from difflib import SequenceMatcher

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

# squash：去空白与标点，仅保留可比对的实义字符（语料与引文用同一函数）
PUNCT_RE = re.compile(r'[\s　，。、；：？！“”‘’"\'（）()·．\.,：「」『』《》〈〉—\-–…\[\]【】〇]')
def squash(s: str) -> str:
    return PUNCT_RE.sub('', s)

JUAN_RE = re.compile(r'^卷[一二三四五六七八九十]')
CHAP_RE = re.compile(r'^第[一二三四五六七八九十百零]+章')
QNUM_RE = re.compile(r'^(\d+)、')
SRC_TAIL_RE = re.compile(r'（《[^》]+》[^）]*）\s*$')

MIN_MATCH = 10   # 引文 squash 长度 < 此值不参与匹配，避免短串误命中
ANCHOR = 16      # 锚点长度：用首/尾锚点定位源段，容忍引文内部个别字差异（错字/版本差）


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


# ---------------- 语料白话索引 ----------------
def build_corpus_index():
    """逐行索引全站语料原文→白话。返回 (BIG, starts, line_art, art_lines)。
    - BIG：各行 squash 原文按篇拼接，篇间以 \\x01 分隔；starts/line_art：每行起点与所属篇
      序号（仅用于「锚点 → 候选篇」定位）。
    - art_lines：按篇分组的 [(squash原文行, 该行白话|None), …]，匹配时在候选篇内逐行判定。"""
    chunks, starts, line_art, art_lines = [], [], [], []
    pos = 0
    for f in sorted(glob.glob(os.path.join(ART, "*.json"))):
        b = os.path.basename(f)
        # 排除：嘉言录(主题摘录)、自身 q600，以及 jx「白话精选读本」——
        # jx 是文钞选段，内容全在增广/续编/三编里，且其按整段成行（行很长），
        # 会让锚点先命中粗粒度长行而漏配；统一改由句级分行的全本卷匹配。
        if b.startswith("jy-") or b.startswith("jx-") or b.startswith(VOL_ID + "-"):
            continue
        art = json.load(open(f, encoding="utf-8"))
        aidx = len(art_lines)
        lines = []
        for seg in art.get("segments", []):
            o = seg.get("orig", [])
            t = seg.get("trans", [])
            paired = len(o) == len(t) and len(o) > 0  # paired 段内逐行对齐
            for i, line in enumerate(o):
                sl = squash(line)
                if not sl:
                    continue
                starts.append(pos)
                chunks.append(sl)
                pos += len(sl)
                line_art.append(aidx)
                lines.append((sl, t[i] if paired else None))
        chunks.append('\x01')  # 篇分隔
        pos += 1
        art_lines.append(lines)
    return "".join(chunks), starts, line_art, art_lines


MIN_LINE = 8        # 短于此的语料行不参与（避免短串巧合）
LINE_OVL = 0.6      # 语料行须 ≥60% 字符与引文对齐，才取其白话（剔除「引文只占长行一截」的溢出/错位）
COVER = 0.6         # 候选篇须覆盖引文 ≥60%，否则不算命中
SEED = 14           # 候选篇种子锚点长度


def _candidates(qs: str, BIG: str, starts: list, line_art: list):
    """收集所有可能的源篇：沿引文取多个种子锚点，每个锚点找出其**全部**出现处所属篇。
    （不只取首次出现——同一段往往在多卷重复，需全找出来再择优，避免被早出现的粗粒度本垄断。）"""
    L = len(qs)
    if L <= SEED:
        offs = [0]
    else:
        step = max(8, L // 8)
        offs = list(range(0, L - SEED + 1, step)) + [L - SEED]
    cands = set()
    for i in offs:
        anc = qs[i:i + SEED]
        if len(anc) < 10:
            continue
        start, n = 0, 0
        while n < 8:
            p = BIG.find(anc, start)
            if p < 0:
                break
            li = bisect.bisect_right(starts, p) - 1
            if li >= 0:
                cands.add(line_art[li])
            start, n = p + 1, n + 1
    return cands


def match_white(quote: str, idx_data):
    """多候选源篇 → 篇内逐行**严格对齐**取白话：仅纳入干净对齐的语料行（行首即对齐且尾部
    不大溢出，或整行≥75%被覆盖），按其在引文中的位置拼接。多卷重复时择最贴合者；候选篇
    覆盖引文不足 60% 即留白。原则：原文与白话严格对齐，对不齐的宁可留白，绝不给错/溢出。"""
    BIG, starts, line_art, art_lines = idx_data
    qs = squash(quote)
    if len(qs) < MIN_MATCH:
        return None

    cands = _candidates(qs, BIG, starts, line_art)
    if not cands:
        return None

    best = None   # (key, hits)；key=(-覆盖分桶, 溢出度) 越小越好
    need = len(qs) * COVER
    for a in cands:
        hits, cov, tot = [], 0, 0
        for lsq, tr in art_lines[a]:
            if len(lsq) < MIN_LINE:
                continue
            blocks = SequenceMatcher(None, lsq, qs, autojunk=False).get_matching_blocks()
            m = sum(bk.size for bk in blocks)          # 该行与引文总对齐字数（容忍内部插字/异字）
            sig = [bk for bk in blocks if bk.size >= 6]
            if not sig or m < MIN_MATCH:
                continue
            head = sig[0].a                            # 行首未落在引文内的字数
            # 行首即对齐且尾部不大溢出，或整行≥75%被覆盖 —— 否则舍弃（不带出引文范围外内容）
            if (head <= 4 and len(lsq) <= m * 2.0) or m >= len(lsq) * 0.75:
                hits.append((sig[0].b, tr)); cov += m; tot += len(lsq)
        if cov >= need:
            key = (-round(cov / len(qs), 1), round(tot / len(qs), 2))
            if best is None or key < best[0]:
                best = (key, hits)

    if best is None:
        return None
    parts = sorted(best[1], key=lambda x: x[0])
    out = "".join(tr for _p, tr in parts if tr)
    return out or None


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


def build_q_article(block, idx_data, unmatched_acc):
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
    stats = {'matched': 0, 'unmatched': 0}
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
        white = match_white(body, idx_data)
        seg = {'orig': [body], 'trans': [white] if white else [], 'notes': []}
        if src:
            seg['src'] = src
        segments.append(seg)
        if white:
            stats['matched'] += 1
        else:
            stats['unmatched'] += 1
            unmatched_acc.append((block['num'], body))

    juan = block['juan'] or '卷首'
    cat = block['cat']
    paired = any(s['trans'] for s in segments)
    art = {
        'id': f"{VOL_ID}-{block['num']:03d}", 'volume': VOL_ID, 'volumeName': VOL_NAME,
        'juan': juan, 'category': cat or '', 'title': block['title'],
        'translator': '', 'summary': summary, 'segments': segments, 'anomalies': [],
    }
    return art, paired, stats


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

    print("==> 构建语料白话索引（排除 jy / q600）…")
    idx_data = build_corpus_index()
    print(f"   语料行数 {len(idx_data[1])}，BIG 长度 {len(idx_data[0])}")

    article_meta = []      # 有序 (juan, cat, item) 用于 books.json
    unmatched_acc = []     # [(qnum, 引文)]
    total_seg = 0
    tot = {'matched': 0, 'unmatched': 0}
    written = 0

    # 卷首传记
    if bio:
        a = build_bio_article(bio)
        json.dump(a, open(os.path.join(ART, a['id'] + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))
        written += 1
        article_meta.append(('卷首', None, {
            'id': a['id'], 'title': a['title'], 'paired': False,
            'plain': False, 'notes': 0}))

    # 各问
    for block in blocks:
        a, paired, stats = build_q_article(block, idx_data, unmatched_acc)
        json.dump(a, open(os.path.join(ART, a['id'] + '.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))
        written += 1
        total_seg += len(a['segments'])
        for k in tot:
            tot[k] += stats[k]
        article_meta.append((a['juan'], a['category'] or None, {
            'id': a['id'], 'title': a['title'], 'paired': paired,
            'plain': False, 'notes': 0}))

    # books.json：移除旧 q600 后追加
    books = json.load(open(BOOKS, encoding='utf-8'))
    books = [b for b in books if b.get('id') != VOL_ID]
    books.append(assemble_book(article_meta))
    json.dump(books, open(BOOKS, 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    # 报告
    rate = (tot['matched'] / total_seg * 100) if total_seg else 0
    lines = [
        f"# 《印光法师答念佛600问》构建报告",
        "",
        f"- 问题数：{len(blocks)}（末号 {last_num}）；卷首传记：{'1 篇' if bio else '无'}",
        f"- 写出文章 JSON：{written} 篇 → site/data/articles/{VOL_ID}-*.json",
        f"- 引文段总数：{total_seg}",
        f"- 白话命中（原文↔白话严格对齐）：{tot['matched']}　未命中：{tot['unmatched']}"
        f"　**命中率 {rate:.1f}%**",
        "",
        "## 编号告警",
        *(report_warn or ["- 无"]),
        "",
        f"## 未命中引文（{len(unmatched_acc)} 段，只显原文，待人工复核）",
    ]
    for qn, body in unmatched_acc:
        lines.append(f"- [问{qn}] {body[:70]}")
    open(REPORT, 'w', encoding='utf-8').write("\n".join(lines) + "\n")

    print(f"==> 完成：{written} 篇，白话命中率 {rate:.1f}%"
          f"（{tot['matched']}/{total_seg}，原文↔白话严格对齐）")
    print(f"   报告 → {os.path.relpath(REPORT, PROJ)}")
    print("   注意：改了 site/data，请给 site/sw.js 的 VER 升号。")


if __name__ == '__main__':
    main()
