#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
原文对齐校验脚本：从 docx 重新提取原文，与 site/data/articles/*.json 中的 orig 字段逐字对比。
输出差异报告，不修改任何文件。
"""
import json
import re
import zipfile
from collections import defaultdict
from pathlib import Path
from difflib import SequenceMatcher

from lxml import etree

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
SRC = Path('/Users/bincai/lianbang999/3000shan/知识库/印光法师文钞word')
OUT = Path(__file__).resolve().parent.parent / 'site' / 'data' / 'articles'

VOLUMES = [
    {'id': 'zg1', 'file': '01增广印光法师文钞上册--文白对照.docx', 'name': '增广文钞 · 上册', 'group': '增广印光法师文钞'},
    {'id': 'zg2', 'file': '02增广印光法师文钞下册--文白对照.docx', 'name': '增广文钞 · 下册', 'group': '增广印光法师文钞'},
    {'id': 'xb1', 'file': '03印光法师文钞续编上册--文白对照.docx', 'name': '续编 · 上册', 'group': '印光法师文钞续编'},
    {'id': 'xb2', 'file': '04印光法师文钞续编下册--文白对照.docx', 'name': '续编 · 下册', 'group': '印光法师文钞续编'},
    {'id': 'sb1', 'file': '05印光法师文钞三编上册--文白对照.docx', 'name': '三编 · 上册', 'group': '印光法师文钞三编'},
    {'id': 'sb2', 'file': '06印光法师文钞三编下册--文白对照.docx', 'name': '三编 · 下册', 'group': '印光法师文钞三编'},
    {'id': 'sbu', 'file': '07印光法师文钞三编补--文白对照.docx', 'name': '三编补', 'group': '印光法师文钞三编'},
]

CN_NUM = '〇一二三四五六七八九'


def num2cn(n):
    if n <= 10:
        return '十' if n == 10 else CN_NUM[n]
    tens, ones = divmod(n, 10)
    s = ('' if tens == 1 else CN_NUM[tens]) + '十'
    return s + (CN_NUM[ones] if ones else '')


def norm(s):
    return re.sub(r'[\s　]+', '', s).replace('(', '（').replace(')', '）')


RE_JUAN = re.compile(r'^(增广印光法师文钞卷第[一二三四]|印光法师文钞续编卷[上下]|印光法师文钞三编卷第[一二三四]|印光法师文钞三编补)$')
RE_CAT = re.compile(r'^(书|论|序|记|疏|跋|杂著|颂|赞|书信|序跋疏|论文|附录|题词|像赞|楹联|法语|开示|碑记|问答|附|法语开示|偈颂愿文对联|传记记事祭文|颂赞|杂记)[一二三四]?$')
RE_EXPAND = re.compile(r'^(.*?)（([一二三四五六七八九十廿卅]+)）$')
RE_NOTE = re.compile(r'^\[?(\d+)\]\s*(?:【(.+?)】)?(.*)$')
RE_TITLE_HINT = re.compile(r'(书|序|记|论|疏|跋|说|文|铭|颂|赞|偈|启|缘起|规约|章程|题词|像赞|警策|法语|开示|问答|白话|自述|行状|生西|往生|事迹|因缘|碑|塔|功德|意见|挽|联|引|训|示|嘱)')

CN_VAL = {c: i for i, c in enumerate(CN_NUM)}


def cn2num(s):
    s = s.replace('廿', '二十').replace('卅', '三十')
    if s == '十':
        return 10
    if '十' in s:
        a, b = s.split('十', 1)
        return (CN_VAL.get(a, 1) if a else 1) * 10 + (CN_VAL.get(b, 0) if b else 0)
    return CN_VAL.get(s, 0)


def strip_parens(s):
    return re.sub(r'（[^）]*）', '', s)


TITLE_END = set('书序记论疏跋铭颂赞偈文说联词启示诀语录章约辞训诰诫规答问引状述志传缘起仪')


def looks_like_title(nt):
    base = strip_parens(nt).rstrip('一二三四五六七八九十廿卅')
    return bool(base) and (base[-1] in TITLE_END or base.startswith('挽') or bool(RE_CAT.match(base)))


def load_paras(path):
    z = zipfile.ZipFile(path)
    doc = etree.fromstring(z.read('word/document.xml'))
    out = []
    for p in doc.findall(f'.//{W}body/{W}p'):
        text = ''.join(t.text or '' for t in p.iter(f'{W}t')).strip()
        rpr = p.find(f'.//{W}r/{W}rPr')
        bold = rpr is not None and rpr.find(f'{W}b') is not None
        out.append((text, bold))
    return out


def parse_toc(paras, body_start):
    expected = defaultdict(int)
    alias = defaultdict(list)

    def add_alias(a, canon):
        if a and canon not in alias[a]:
            alias[a].append(canon)

    front_start = None
    for i in range(1, body_start):
        t, _ = paras[i]
        if not t:
            continue
        if len(t) > 60:
            if front_start is None:
                front_start = i
            continue
        if front_start is not None:
            continue
        nt = norm(t)
        if nt in ('前言', '缘起') or RE_JUAN.match(nt) or RE_CAT.match(nt):
            if nt == '前言':
                front_start = i
            continue
        if nt.endswith('目次') or nt.startswith('卷') or nt.startswith('印光法师文钞'):
            continue
        if nt.startswith('【') or re.match(r'^\d', nt):
            continue
        if re.search(r'[。，、；]', strip_parens(nt)):
            continue
        m = RE_EXPAND.match(nt)
        if m and cn2num(m.group(2)) >= 2:
            base, n = m.group(1), cn2num(m.group(2))
            for k in range(1, n + 1):
                canon = base + num2cn(k)
                expected[canon] += 1
                add_alias(canon, canon)
                add_alias(f'{base}（{num2cn(k)}）', canon)
                if k >= 20:
                    add_alias(base + num2cn(k).replace('二十', '廿').replace('三十', '卅'), canon)
            add_alias(base, base + '一')
            add_alias(nt, ('G', base, n))
        else:
            expected[nt] += 1
            add_alias(nt, nt)
            add_alias(strip_parens(nt), nt)
            if nt.startswith('附'):
                add_alias(nt[1:], nt)
            if nt.endswith('无翻译'):
                add_alias(nt[:-3], nt)
    return expected, alias, front_start


def new_article(vol, juan, cat, title, seq):
    return {
        'id': f"{vol['id']}-{seq:03d}",
        'volume': vol['id'],
        'volumeName': vol['name'],
        'juan': juan,
        'category': cat,
        'title': title,
        'segments': [],
        'anomalies': [],
    }


def extract_volume(vol):
    """从docx重新提取文章，返回文章列表（与convert.py逻辑一致）"""
    paras = load_paras(SRC / vol['file'])
    n = len(paras)

    body_start = 0
    if vol['id'] != 'sbu':
        for i in range(1, n):
            if RE_JUAN.match(norm(paras[i][0])):
                body_start = i
                break
        assert body_start > 0, f"{vol['file']} 未找到卷头"

    expected, alias, front_start = (defaultdict(int), {}, None)
    if body_start:
        expected, alias, front_start = parse_toc(paras, body_start)

    matched = defaultdict(int)
    fuzzy_matches = []

    def match_expected(nt):
        cands = [nt]
        s = nt
        while s.endswith('）') and '（' in s:
            s = s[:s.rfind('（')]
            cands.append(s)
        cands.append(strip_parens(nt))
        for c in list(cands):
            if c.startswith('附录'):
                cands.append(c[2:])
            elif c.startswith('附'):
                cands.append(c[1:])
        swapped = []
        for c in cands:
            if c[:1] == '复':
                swapped.append('与' + c[1:])
            elif c[:1] == '与':
                swapped.append('复' + c[1:])
        for fuzzy, group in ((False, cands), (True, swapped)):
            for cand in group:
                canons = list(alias.get(cand, ()))
                canons.sort(key=lambda c: isinstance(c, tuple), reverse=vol['id'].startswith('xb'))
                for canon in canons:
                    if isinstance(canon, tuple):
                        _, base, n = canon
                        members = [base + num2cn(k) for k in range(1, n + 1)]
                        if all(expected.get(m, 0) > matched[m] for m in members):
                            if fuzzy:
                                fuzzy_matches.append(nt)
                            return members
                    elif expected.get(canon, 0) > matched[canon]:
                        if fuzzy:
                            fuzzy_matches.append(nt)
                        return [canon]
        return None

    def match_contain(nt):
        b = strip_parens(nt)
        if len(b) < 6:
            return None
        for t, cnt in expected.items():
            if cnt <= matched[t] or len(t) < 6:
                continue
            ts = strip_parens(t)
            ok = b.startswith(ts) or ts.startswith(b) or b.endswith(ts)
            if not ok and b[-1] == ts[-1]:
                it = iter(b)
                ok = all(ch in it for ch in ts)
            if ok:
                fuzzy_matches.append(f'{nt}↔{t}')
                return [t]
        return None

    articles = []
    seq = 0

    if front_start is not None:
        seq += 1
        art = new_article(vol, '卷首', '导读', '前言与文钞白话摘录', seq)
        art['plain'] = True
        art['segments'] = [{'orig': [t for t, _ in paras[front_start:body_start] if t], 'trans': [], 'notes': []}]
        articles.append(art)

    juan, cat = '', ''
    cur = None
    seg = None
    state = 'idle'
    heuristic_titles = []
    untitled = []

    def close_article():
        nonlocal cur, seg, state
        if cur is not None:
            articles.append(cur)
        cur, seg, state = None, None, 'idle'

    def open_article(title):
        nonlocal cur, seg, state, seq
        close_article()
        seq += 1
        cur = new_article(vol, juan, cat, title, seq)
        seg = {'orig': [], 'trans': [], 'notes': []}
        cur['segments'].append(seg)
        state = 'orig'

    def new_segment():
        nonlocal seg, state
        seg = {'orig': [], 'trans': [], 'notes': []}
        cur['segments'].append(seg)
        state = 'orig'

    for i in range(body_start, n):
        t, bold = paras[i]
        if not t:
            continue
        nt = norm(t)

        if RE_JUAN.match(nt):
            close_article()
            juan = t
            continue
        if bold and len(nt) <= 8 and RE_CAT.match(nt):
            close_article()
            cat = nt
            continue

        if len(nt) <= 60:
            canons = match_expected(nt)
            if canons:
                for c in canons:
                    matched[c] += 1
                open_article(t)
                continue
        core = strip_parens(nt)
        if (bold and 4 <= len(core) <= 45
                and not re.search(r'[。，；：？！、]', core)
                and not re.match(r'^[\d【\[]', nt)
                and looks_like_title(nt)):
            canons = match_contain(nt) if len(nt) <= 60 else None
            if canons:
                for c in canons:
                    matched[c] += 1
                open_article(t)
                continue
            if cur is None or vol['id'] == 'sbu':
                heuristic_titles.append((nt, juan, cat))
                open_article(t)
                continue

        if cur is None:
            open_article(f'〔{cat or juan or "无题"}〕')
            cur['untitled'] = True
            untitled.append((i, t[:30]))

        if nt.startswith('【译文】') or nt == '【译文】':
            state = 'trans'
            rest = t.strip()[4:].strip() if norm(t).startswith('【译文】') else ''
            rest = re.sub(r'^【译文】', '', t).strip()
            if rest:
                seg['trans'].append(rest)
            continue
        if nt.startswith('【注释】') or nt == '【注释】':
            state = 'notes'
            rest = re.sub(r'^【注释】', '', t).strip()
            if rest:
                seg['notes'].append(rest)
            continue

        if state == 'orig':
            if not bold:
                cur['anomalies'].append(f'第{i}段：原文区出现非粗体段')
            seg['orig'].append(t)
        elif state == 'trans':
            if bold:
                new_segment()
                seg['orig'].append(t)
            else:
                seg['trans'].append(t)
        elif state == 'notes':
            if bold and not RE_NOTE.match(nt) and '。' in t and len(nt) >= 30:
                new_segment()
                seg['orig'].append(t)
            else:
                seg['notes'].append(t)
    close_article()

    # 注释结构化
    for art in articles:
        for s in art['segments']:
            notes = []
            for line in s['notes']:
                m = RE_NOTE.match(line)
                if m and m.group(1):
                    notes.append({'n': int(m.group(1)), 'term': m.group(2) or '', 'text': m.group(3).strip()})
                elif notes:
                    notes[-1]['text'] += '\n' + line
                else:
                    notes.append({'n': 0, 'term': '', 'text': line})
            s['notes'] = notes

    return articles


def compare_orig(extracted, json_data):
    """对比提取的orig与JSON中的orig，返回差异列表"""
    diffs = []

    # 对比标题
    if extracted['title'] != json_data['title']:
        diffs.append({
            'type': 'title_mismatch',
            'desc': f"标题不一致：提取='{extracted['title']}' vs JSON='{json_data['title']}'"
        })

    # 对比segment数量
    ext_segs = extracted['segments']
    json_segs = json_data['segments']

    if len(ext_segs) != len(json_segs):
        diffs.append({
            'type': 'segment_count',
            'desc': f"segment数不一致：提取={len(ext_segs)} vs JSON={len(json_segs)}"
        })

    # 逐segment对比orig
    max_segs = max(len(ext_segs), len(json_segs))
    for si in range(max_segs):
        if si >= len(ext_segs):
            diffs.append({
                'type': 'segment_missing_in_extracted',
                'desc': f"segment[{si}]：提取结果中缺失，JSON中有{len(json_segs[si]['orig'])}段原文"
            })
            continue
        if si >= len(json_segs):
            diffs.append({
                'type': 'segment_missing_in_json',
                'desc': f"segment[{si}]：JSON中缺失，提取结果中有{len(ext_segs[si]['orig'])}段原文"
            })
            continue

        ext_orig = ext_segs[si]['orig']
        json_orig = json_segs[si]['orig']

        if len(ext_orig) != len(json_orig):
            diffs.append({
                'type': 'orig_count',
                'desc': f"segment[{si}]原文段数不一致：提取={len(ext_orig)} vs JSON={len(json_orig)}"
            })

        # 逐段对比
        max_lines = max(len(ext_orig), len(json_orig))
        for li in range(max_lines):
            if li >= len(ext_orig):
                diffs.append({
                    'type': 'line_missing_in_extracted',
                    'desc': f"segment[{si}].orig[{li}]：提取结果中缺失",
                    'json_text': json_orig[li][:100]
                })
                continue
            if li >= len(json_orig):
                diffs.append({
                    'type': 'line_missing_in_json',
                    'desc': f"segment[{si}].orig[{li}]：JSON中缺失",
                    'ext_text': ext_orig[li][:100]
                })
                continue

            ext_line = ext_orig[li]
            json_line = json_orig[li]

            if ext_line != json_line:
                # 找出具体差异
                diff_detail = find_char_diff(ext_line, json_line)
                diffs.append({
                    'type': 'content_diff',
                    'desc': f"segment[{si}].orig[{li}]：内容不一致",
                    'detail': diff_detail,
                    'ext_line': ext_line[:200],
                    'json_line': json_line[:200]
                })

    return diffs


def find_char_diff(s1, s2):
    """找出两个字符串的具体字符差异"""
    diffs = []
    matcher = SequenceMatcher(None, s1, s2)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == 'equal':
            continue
        if tag == 'replace':
            diffs.append(f"位置{i1}-{i2-1}：提取='{s1[i1:i2]}' → JSON='{s2[j1:j2]}'")
        elif tag == 'delete':
            diffs.append(f"位置{i1}-{i2-1}：提取多出'{s1[i1:i2]}'")
        elif tag == 'insert':
            diffs.append(f"位置{i1}：JSON多出'{s2[j1:j2]}'")
    return diffs


def main():
    report_lines = []
    total_articles = 0
    total_diff_articles = 0
    total_diffs = 0
    vol_summaries = []

    for vol in VOLUMES:
        print(f"处理 {vol['name']}...")
        extracted_articles = extract_volume(vol)

        vol_diff_count = 0
        vol_diff_articles = 0
        vol_details = []

        for ext_art in extracted_articles:
            art_id = ext_art['id']
            json_path = OUT / f"{art_id}.json"

            total_articles += 1

            if not json_path.exists():
                vol_diff_count += 1
                vol_diff_articles += 1
                vol_details.append(f"  - {art_id} '{ext_art['title']}'：JSON文件不存在")
                continue

            with open(json_path, 'r', encoding='utf-8') as f:
                json_art = json.load(f)

            diffs = compare_orig(ext_art, json_art)

            if diffs:
                vol_diff_count += len(diffs)
                vol_diff_articles += 1
                vol_details.append(f"  - {art_id} '{ext_art['title']}'（{len(diffs)}处差异）：")
                for d in diffs:
                    vol_details.append(f"    [{d['type']}] {d['desc']}")
                    if 'detail' in d and d['detail']:
                        for dd in d['detail'][:5]:  # 最多显示5处字符差异
                            vol_details.append(f"      {dd}")
                    if 'ext_line' in d:
                        vol_details.append(f"      提取: {d['ext_line']}")
                    if 'json_line' in d:
                        vol_details.append(f"      JSON:  {d['json_line']}")

        total_diff_articles += vol_diff_articles
        total_diffs += vol_diff_count

        vol_summaries.append({
            'name': vol['name'],
            'id': vol['id'],
            'total': len(extracted_articles),
            'diff_articles': vol_diff_articles,
            'diff_count': vol_diff_count,
        })

        print(f"  {len(extracted_articles)} 篇，{vol_diff_articles} 篇有差异，共 {vol_diff_count} 处")

    # 生成报告
    report_lines.append("# 原文对齐校验报告")
    report_lines.append("")
    report_lines.append("## 总体概览")
    report_lines.append("")
    report_lines.append(f"- 总文章数：{total_articles}")
    report_lines.append(f"- 有差异的文章数：{total_diff_articles}")
    report_lines.append(f"- 总差异数：{total_diffs}")
    if total_diffs == 0:
        report_lines.append("")
        report_lines.append("**结论：所有文章原文与docx原文完全对齐，一字不差。**")
    else:
        report_lines.append("")
        report_lines.append(f"**结论：{total_diff_articles} 篇文章存在 {total_diffs} 处差异，需要人工复核。**")
    report_lines.append("")

    report_lines.append("## 各卷册统计")
    report_lines.append("")
    report_lines.append("| 卷册 | 文章数 | 有差异文章数 | 差异数 |")
    report_lines.append("|------|--------|-------------|--------|")
    for vs in vol_summaries:
        report_lines.append(f"| {vs['name']} | {vs['total']} | {vs['diff_articles']} | {vs['diff_count']} |")
    report_lines.append("")

    if total_diffs > 0:
        report_lines.append("## 差异明细")
        report_lines.append("")
        for vol in VOLUMES:
            # 重新提取并对比以获取明细
            extracted_articles = extract_volume(vol)
            vol_has_diff = False
            for ext_art in extracted_articles:
                art_id = ext_art['id']
                json_path = OUT / f"{art_id}.json"
                if not json_path.exists():
                    if not vol_has_diff:
                        report_lines.append(f"### {vol['name']}")
                        report_lines.append("")
                        vol_has_diff = True
                    report_lines.append(f"- **{art_id}** '{ext_art['title']}'：JSON文件不存在")
                    continue
                with open(json_path, 'r', encoding='utf-8') as f:
                    json_art = json.load(f)
                diffs = compare_orig(ext_art, json_art)
                if diffs:
                    if not vol_has_diff:
                        report_lines.append(f"### {vol['name']}")
                        report_lines.append("")
                        vol_has_diff = True
                    report_lines.append(f"- **{art_id}** '{ext_art['title']}'（{len(diffs)}处差异）：")
                    for d in diffs:
                        report_lines.append(f"  - [{d['type']}] {d['desc']}")
                        if 'detail' in d and d['detail']:
                            for dd in d['detail'][:5]:
                                report_lines.append(f"    - {dd}")
                        if 'ext_line' in d:
                            report_lines.append(f"    - 提取: `{d['ext_line']}`")
                        if 'json_line' in d:
                            report_lines.append(f"    - JSON:  `{d['json_line']}`")
            if vol_has_diff:
                report_lines.append("")

    report_path = Path(__file__).resolve().parent / 'alignment_report.md'
    report_path.write_text('\n'.join(report_lines), encoding='utf-8')
    print(f"\n报告已写入：{report_path}")
    print(f"总计：{total_articles} 篇，{total_diff_articles} 篇有差异，{total_diffs} 处差异")


if __name__ == '__main__':
    main()
