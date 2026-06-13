#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实验版数据 → 主项目数据 迁移脚本

源（parse_wenchao.py 产出，白话版底本，逐段配对）：
  {vol}/index.json  {id,title,parts:[{title,articles:[{id,title,summary}]}]}
  {vol}/articles/{id}.json
    segments: {"o","t"}配对 / {"o"} / {"t"} / {"os","ts"}连排 / {"n","note"}注释

目标（主项目 site/data，纸墨前端）：
  books.json 卷册树 + articles/{主id}.json
    segments: [{orig:[], trans:[], notes:[{n,term,text}]}]

铁律：只转结构、不改一字；译者/提要原样保留；异常如实写报告。

用法: python3 migrate_v2.py 00
"""
import json
import os
import re
import sys

# 中间产物区：parse_v2.py 产出（实验模型 + 对账报告）
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_BASE = os.path.join(PROJ, 'build')
OUT = os.path.join(PROJ, 'site', 'data')

# 各册在主项目中的标识与陈列名（00 先行，01-07 提取完成后照此扩充）
VOLS = {
    '00': {'id': 'jx', 'name': '白话精选读本', 'group': '印光法师文钞白话精选读本', 'pos': 0},
    'jy': {'id': 'jy', 'name': '嘉言录', 'group': '印光法师嘉言录 · 十编主题分类', 'pos': 1},
    '01': {'id': 'zg1', 'name': '增广文钞 · 上册', 'group': '增广印光法师文钞', 'pos': 2},
    '02': {'id': 'zg2', 'name': '增广文钞 · 下册', 'group': '增广印光法师文钞', 'pos': 3},
    '03': {'id': 'xb1', 'name': '续编 · 上册', 'group': '印光法师文钞续编', 'pos': 4},
    '04': {'id': 'xb2', 'name': '续编 · 下册', 'group': '印光法师文钞续编', 'pos': 5},
    '05': {'id': 'sb1', 'name': '三编 · 上册', 'group': '印光法师文钞三编', 'pos': 6},
    '06': {'id': 'sb2', 'name': '三编 · 下册', 'group': '印光法师文钞三编', 'pos': 7},
    '07': {'id': 'sbu', 'name': '三编补', 'group': '印光法师文钞三编', 'pos': 8},
}

NOTE_TERM_RE = re.compile(r'^【([^】]{1,24})】\s*(.*)$', re.S)
# 底本中的"【注释】"节标题行：结构性装饰，前端自带注释区头，迁移时剔除
NOTE_HEADER = {'【注释】', '注释', '【注释】：', '注释：', '【注：】', '注：', '【注】'}


def is_note_header(s):
    return re.sub(r'[\s　]+', '', s) in NOTE_HEADER


def convert_segments(src_segs, report, title):
    """实验版段列表 → 主项目段组列表。

    连续 {o,t} 归入一个配对段组；{o}/{t} 单侧连排各自成组；
    {os,ts} 本身就是配对块；注释挂在其所在位置的当前段组上，
    注释之后再有正文则另起段组（保持原文中注释的分组位置）。
    """
    out = []
    cur = {'orig': [], 'trans': [], 'notes': []}
    kind = None  # paired | orig | trans

    def flush():
        nonlocal cur, kind
        if cur['orig'] or cur['trans'] or cur['notes']:
            out.append(cur)
        cur = {'orig': [], 'trans': [], 'notes': []}
        kind = None

    def parse_note(g):
        m = NOTE_TERM_RE.match(g['note'])
        if m:
            return {'n': g['n'], 'term': m.group(1), 'text': m.group(2).strip()}
        return {'n': g['n'], 'term': '', 'text': g['note']}

    # 预处理：剔除"【注释】"节标题行（计数交由调用方报告）
    cleaned = []
    for g in src_segs:
        if 'n' in g or 'os' in g:
            cleaned.append(g)
            continue
        o, t = g.get('o'), g.get('t')
        drop_o = o is not None and is_note_header(o)
        drop_t = t is not None and is_note_header(t)
        if drop_o or drop_t:
            convert_segments.dropped += int(drop_o) + int(drop_t)
            g = {}
            if o is not None and not drop_o:
                g['o'] = o
            if t is not None and not drop_t:
                g['t'] = t
            if not g:
                continue
        cleaned.append(g)
    src_segs = cleaned

    for g in src_segs:
        if 'n' in g:
            # 注释：挂当前段组；当前为空则挂上一段组
            note = parse_note(g)
            if cur['orig'] or cur['trans']:
                cur['notes'].append(note)
            elif out:
                out[-1]['notes'].append(note)
            else:
                cur['notes'].append(note)
            continue
        if cur['notes']:
            flush()  # 注释块结束后再有正文 → 新段组
        if 'os' in g:
            flush()
            seg = {'orig': list(g['os']), 'trans': list(g['ts']), 'notes': []}
            if g.get('src'):
                seg['src'] = g['src']  # 条目出处（嘉言录：所引文钞篇目）
            out.append(seg)
            continue
        if 'o' in g and 't' in g:
            if kind not in (None, 'paired'):
                flush()
            cur['orig'].append(g['o'])
            cur['trans'].append(g['t'])
            kind = 'paired'
        elif 'o' in g:
            if kind not in (None, 'orig'):
                flush()
            cur['orig'].append(g['o'])
            kind = 'orig'
        elif 't' in g:
            if kind not in (None, 'trans'):
                flush()
            cur['trans'].append(g['t'])
            kind = 'trans'
    flush()

    # 注释编号查重（同篇多组注释会重号，前端按先到先得解析角标）
    ns = [n['n'] for s in out for n in s['notes']]
    if len(ns) != len(set(ns)):
        report.append(f'  ⚠ [{title}] 注释编号有重复（多组注释），行内角标按首个匹配解析')
    return out


def migrate(vol):
    cfg = VOLS[vol]
    src_dir = os.path.join(SRC_BASE, vol)
    index = json.load(open(os.path.join(src_dir, 'index.json'), encoding='utf-8'))
    report = [f'迁移 {vol} → {cfg["id"]}（{index["title"]}）']
    convert_segments.dropped = 0

    os.makedirs(os.path.join(OUT, 'articles'), exist_ok=True)
    # 清理本册旧版文章文件（旧管线编号与新版不一致，避免残留混杂）
    import glob as _glob
    stale = _glob.glob(os.path.join(OUT, 'articles', f"{cfg['id']}-*.json"))
    for f in stale:
        os.remove(f)
    if stale:
        report.append(f'  已清理旧版文章文件 {len(stale)} 个')
    tree = {'id': cfg['id'], 'name': cfg['name'], 'group': cfg['group'], 'juans': []}
    jmap = {}
    count = 0
    paired_total = 0

    for part in index['parts']:
        for meta in part['articles']:
            src = json.load(open(os.path.join(src_dir, 'articles', meta['id'] + '.json'), encoding='utf-8'))
            count += 1
            new_id = f"{cfg['id']}-{src['id']}"
            segs = convert_segments(src['segments'], report, src['title'])
            art = {
                'id': new_id,
                'volume': cfg['id'],
                'volumeName': cfg['name'],
                'juan': src.get('part') or part['title'],
                'category': '',
                'title': src['title'],
                'translator': src.get('translator', ''),
                'summary': src.get('summary', ''),
                'segments': segs,
                'anomalies': [],
            }
            with open(os.path.join(OUT, 'articles', new_id + '.json'), 'w', encoding='utf-8') as f:
                json.dump(art, f, ensure_ascii=False)

            paired = all(len(s['orig']) == len(s['trans']) for s in segs if s['trans'])
            if paired:
                paired_total += 1
            key = art['juan']
            if key not in jmap:
                jmap[key] = {'name': key, 'cats': [{'name': '正文', 'items': []}]}
                tree['juans'].append(jmap[key])
            jmap[key]['cats'][0]['items'].append({
                'id': new_id, 'title': src['title'], 'paired': paired,
                'plain': False,
                'notes': sum(len(s['notes']) for s in segs),
            })

    # 合并 books.json：同 id 先移除，再按 pos 插入
    books_path = os.path.join(OUT, 'books.json')
    books = json.load(open(books_path, encoding='utf-8')) if os.path.exists(books_path) else []
    books = [b for b in books if b['id'] != cfg['id']]
    books.insert(min(cfg['pos'], len(books)), tree)
    with open(books_path, 'w', encoding='utf-8') as f:
        json.dump(books, f, ensure_ascii=False)

    # 名相库合并
    terms_path = os.path.join(OUT, 'terms.json')
    terms = json.load(open(terms_path, encoding='utf-8')) if os.path.exists(terms_path) else {}
    # 先清掉本册旧词条
    for k in list(terms):
        terms[k] = [e for e in terms[k] if not e['a'].startswith(cfg['id'] + '-')]
        if not terms[k]:
            del terms[k]
    for part in index['parts']:
        for meta in part['articles']:
            art = json.load(open(os.path.join(OUT, 'articles', f"{cfg['id']}-{meta['id']}.json"), encoding='utf-8'))
            for s in art['segments']:
                for n in s['notes']:
                    if n['term']:
                        terms.setdefault(n['term'], []).append({'a': art['id'], 'n': n['n']})
    with open(terms_path, 'w', encoding='utf-8') as f:
        json.dump(terms, f, ensure_ascii=False)

    report.append(f'  共 {count} 篇，全篇配对 {paired_total} 篇，已并入 books.json（第 {cfg["pos"]+1} 位）')
    if convert_segments.dropped:
        report.append(f'  已剔除"【注释】"节标题行 {convert_segments.dropped} 处')
    print('\n'.join(report))


if __name__ == '__main__':
    migrate(sys.argv[1] if len(sys.argv) > 1 else '00')
