#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
印光法师文钞 docx → JSON 转换管线

格式规律（7册已逐一验证）：
  - 每册开头为目次（07三编补除外，无目次）
  - 正文：粗体段=文言原文，【译文】块=白话，【注释】块=编号注释
  - 目录条目「题名（N）」在正文展开为「题名一」…「题名N」共N篇
  - 卷头如「增广印光法师文钞卷第一」，类别头如「书 一」「论」「疏」

铁律：原文不可篡改。本脚本只切分、不改字；一切异常如实写入校验报告，
      由人工复核，绝不静默"修正"。
"""
import json
import re
import zipfile
from collections import defaultdict
from pathlib import Path

from lxml import etree

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
SRC = Path('/Users/bincai/Downloads/印光法师文钞word')
OUT = Path(__file__).resolve().parent.parent / 'site' / 'data'

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
    """1-99 转汉字数字（书信编号用）"""
    if n <= 10:
        return '十' if n == 10 else CN_NUM[n]
    tens, ones = divmod(n, 10)
    s = ('' if tens == 1 else CN_NUM[tens]) + '十'
    return s + (CN_NUM[ones] if ones else '')


def norm(s):
    """规范化：去全部空白、半角括号转全角，便于目录与正文标题比对（不改动输出文本）"""
    return re.sub(r'[\s　]+', '', s).replace('(', '（').replace(')', '）')


# 卷头（规范化后全匹配）
RE_JUAN = re.compile(r'^(增广印光法师文钞卷第[一二三四]|印光法师文钞续编卷[上下]|印光法师文钞三编卷第[一二三四]|印光法师文钞三编补)$')
# 类别头（规范化后全匹配，含三编补的复合类别）
RE_CAT = re.compile(r'^(书|论|序|记|疏|跋|杂著|颂|赞|书信|序跋疏|论文|附录|题词|像赞|楹联|法语|开示|碑记|问答|附|法语开示|偈颂愿文对联|传记记事祭文|颂赞|杂记)[一二三四]?$')
# 目录条目中的多篇展开标记：题名（三）／题名（廿三）
RE_EXPAND = re.compile(r'^(.*?)（([一二三四五六七八九十廿卅]+)）$')
# 注释条目起始：[1]【词条】
RE_NOTE = re.compile(r'^\[?(\d+)\]\s*(?:【(.+?)】)?(.*)$')
# 正文疑似标题关键字（仅用于目录未列篇目的启发式兜底，全部记入报告）
RE_TITLE_HINT = re.compile(r'(书|序|记|论|疏|跋|说|文|铭|颂|赞|偈|启|缘起|规约|章程|题词|像赞|警策|法语|开示|问答|白话|自述|行状|生西|往生|事迹|因缘|碑|塔|功德|意见|挽|联|引|训|示|嘱)')

CN_VAL = {c: i for i, c in enumerate(CN_NUM)}


def cn2num(s):
    """汉字数字转 int（一~九十九，含廿/卅）"""
    s = s.replace('廿', '二十').replace('卅', '三十')
    if s == '十':
        return 10
    if '十' in s:
        a, b = s.split('十', 1)
        return (CN_VAL.get(a, 1) if a else 1) * 10 + (CN_VAL.get(b, 0) if b else 0)
    return CN_VAL.get(s, 0)


def strip_parens(s):
    """去掉全部（…）括注，用于标题比对（不影响输出文本）"""
    return re.sub(r'（[^）]*）', '', s)


# 标题结尾字集：正文疑似标题须以这些字结尾（去括注、去编号后），降低误判
TITLE_END = set('书序记论疏跋铭颂赞偈文说联词启示诀语录章约辞训诰诫规答问引状述志传缘起仪')


def looks_like_title(nt):
    base = strip_parens(nt).rstrip('一二三四五六七八九十廿卅')
    return bool(base) and (base[-1] in TITLE_END or base.startswith('挽') or bool(RE_CAT.match(base)))


def load_paras(path):
    """读取 docx 全部段落 → [(文本, 是否粗体)]"""
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
    """解析目次区 → (期望标题计数, 别名表 alias→规范名, 前置导读区起点)

    别名表用于容错匹配：正文标题常带「（民国二十一年）」等括注，
    多篇书信的第一篇常不带「一」字。
    """
    expected = defaultdict(int)
    alias = defaultdict(list)  # 一个写法可对应多个候选（如「题名（二）」= 第二封 或 两封合篇）

    def add_alias(a, canon):
        if a and canon not in alias[a]:
            alias[a].append(canon)

    front_start = None
    for i in range(1, body_start):
        t, _ = paras[i]
        if not t:
            continue
        # 长段落（>60字）说明目次已结束、进入编者前言/序等正文性内容
        if len(t) > 60:
            if front_start is None:
                front_start = i
            continue
        if front_start is not None:
            continue  # 前置导读区内的短行（小标题等）不算目录条目
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
            continue  # 括注外含标点的行是目录中的说明文字，不是篇名
        m = RE_EXPAND.match(nt)
        if m and cn2num(m.group(2)) >= 2:
            base, n = m.group(1), cn2num(m.group(2))
            for k in range(1, n + 1):
                canon = base + num2cn(k)
                expected[canon] += 1
                add_alias(canon, canon)
                add_alias(f'{base}（{num2cn(k)}）', canon)
                if k >= 20:  # 正文常用「廿一」「卅」简写
                    add_alias(base + num2cn(k).replace('二十', '廿').replace('三十', '卅'), canon)
            add_alias(base, base + '一')  # 第一篇常不带编号
            # 续编正文不展开：「题名（二）」整体为一篇 → 组别名，命中时消耗全组
            add_alias(nt, ('G', base, n))
        else:
            expected[nt] += 1
            add_alias(nt, nt)
            add_alias(strip_parens(nt), nt)
            if nt.startswith('附'):
                add_alias(nt[1:], nt)  # 正文常省「附」字
            if nt.endswith('无翻译'):
                add_alias(nt[:-3], nt)  # 目录的「（无翻译）」标注
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


def parse_volume(vol, report):
    paras = load_paras(SRC / vol['file'])
    n = len(paras)

    # 定位正文起点：第一个匹配卷头的段（07 整册即正文）
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
    expected_total = sum(expected.values())

    def match_expected(nt):
        """目录驱动标题匹配，返回应消耗的规范名列表。

        匹配顺序：原样 → 逐层剥掉末尾括注（日期等）→ 去全部括注；
        再容错正文「复/与」用字不一致（如实记入报告）。
        组别名（续编不展开的「题名（N）」）命中时消耗全组 N 篇。
        """
        cands = [nt]
        s = nt
        while s.endswith('）') and '（' in s:
            s = s[:s.rfind('（')]
            cands.append(s)
        cands.append(strip_parens(nt))
        for c in list(cands):  # 正文常多「附录/附」前缀
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
                # 续编正文不展开多篇书信 → 合篇优先；其余各册单篇优先
                canons.sort(key=lambda c: isinstance(c, tuple), reverse=vol['id'].startswith('xb'))
                for canon in canons:
                    if isinstance(canon, tuple):  # 组别名：消耗全组
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
        """包含式容错：目录用简称、正文用全称（如「南五台茅篷记」↔
        「陕西南五台山大觉岩西林茅篷专修净业缘起记」）。
        规则：去括注后，目录题名是正文题名的前缀/后缀，或字符按序出现
        且末字相同。命中一律记入报告供人工复核。
        """
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
                ok = all(ch in it for ch in ts)  # 子序列
            if ok:
                fuzzy_matches.append(f'{nt}↔{t}')
                return [t]
        return None

    articles = []
    seq = 0

    # 前置导读区（前言+简要说明+缘起+白话摘录）按"通读"型文章保存。
    # 简要说明已由用户直接合入 01 docx 前言之后（2026-06-11 定），自然提取即可。
    if front_start is not None:
        seq += 1
        art = new_article(vol, '卷首', '导读', '前言与文钞白话摘录', seq)
        art['plain'] = True
        art['segments'] = [{'orig': [t for t, _ in paras[front_start:body_start] if t], 'trans': [], 'notes': []}]
        articles.append(art)

    juan, cat = '', ''
    cur = None          # 当前文章
    seg = None          # 当前段组 {orig, trans, notes}
    state = 'idle'      # idle | orig | trans | notes
    heuristic_titles = []
    fuzzy_matches = []
    untitled = []
    matched = defaultdict(int)

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

        # 目录驱动的标题识别（不限粗体：三编目录与正文均有非粗体情形）
        if len(nt) <= 60:
            canons = match_expected(nt)
            if canons:
                for c in canons:
                    matched[c] += 1
                open_article(t)
                continue
        # 启发式标题兜底（无目次的三编补、目录漏列篇目），全部记入报告。
        # 条件从严：粗体、去括注后无标点、以标题常见字结尾
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
            # 类别头之后出现无标题行的内容（如续编"跋"组）：
            # 开"无题"文章承接，不丢内容，并记入报告
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
                # 原文区出现非粗体段：如实保留并标记异常
                cur['anomalies'].append(f'第{i}段：原文区出现非粗体段')
            seg['orig'].append(t)
        elif state == 'trans':
            if bold:
                # 译文区遇到粗体长文 → 同篇内的下一组原文（多段组文章）
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

    # 注释条目结构化：[n]【词条】释文（跨段续行并入上一条）
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

    # ---- 校验统计（如实报告，不修正）----
    matched_total = sum(matched.values())
    unmatched = {k: v - matched[k] for k, v in expected.items() if v > matched[k]}
    mismatch, no_trans = [], []
    for art in articles:
        if art.get('plain'):
            continue
        po = sum(len(s['orig']) for s in art['segments'])
        pt = sum(len(s['trans']) for s in art['segments'])
        if pt == 0:
            no_trans.append(art)
        elif any(len(s['orig']) != len(s['trans']) and s['trans'] for s in art['segments']):
            mismatch.append((art, po, pt))
    report['volumes'].append({
        'vol': vol, 'paras': n, 'body_start': body_start,
        'expected': expected_total, 'matched': matched_total,
        'unmatched': unmatched, 'heuristic': heuristic_titles,
        'fuzzy': fuzzy_matches, 'untitled': untitled,
        'articles': len(articles), 'mismatch': mismatch, 'no_trans': no_trans,
        'anomalies': sum(len(a['anomalies']) for a in articles),
    })
    return articles


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'articles').mkdir(exist_ok=True)
    report = {'volumes': [], 'stray': []}
    books, terms = [], defaultdict(list)
    total = 0

    for vol in VOLUMES:
        articles = parse_volume(vol, report)
        total += len(articles)
        # 册 → 卷 → 类别 → 篇 目录树
        tree = {'id': vol['id'], 'name': vol['name'], 'group': vol['group'], 'juans': []}
        jmap = {}
        for art in articles:
            paired = all(len(s['orig']) == len(s['trans']) for s in art['segments'] if s['trans']) and not art.get('plain')
            key = art['juan'] or vol['name']
            if key not in jmap:
                jmap[key] = {'name': key, 'cats': []}
                tree['juans'].append(jmap[key])
            cats = jmap[key]['cats']
            if not cats or cats[-1]['name'] != (art['category'] or '正文'):
                cats.append({'name': art['category'] or '正文', 'items': []})
            cats[-1]['items'].append({
                'id': art['id'], 'title': art['title'], 'paired': paired,
                'plain': art.get('plain', False),
                'notes': sum(len(s['notes']) for s in art['segments']),
            })
            for s in art['segments']:
                for note in s['notes']:
                    if note['term']:
                        terms[note['term']].append({'a': art['id'], 'n': note['n']})
            with open(OUT / 'articles' / f"{art['id']}.json", 'w', encoding='utf-8') as f:
                json.dump(art, f, ensure_ascii=False)
        books.append(tree)

    with open(OUT / 'books.json', 'w', encoding='utf-8') as f:
        json.dump(books, f, ensure_ascii=False)
    with open(OUT / 'terms.json', 'w', encoding='utf-8') as f:
        json.dump(terms, f, ensure_ascii=False)

    # ---- 校验报告 ----
    lines = ['# 转换校验报告\n', f'共输出 {total} 篇文章、{len(terms)} 个名相词条。\n']
    for r in report['volumes']:
        v = r['vol']
        lines.append(f"\n## {v['name']}（{v['file']}）")
        lines.append(f"- 总段落 {r['paras']}，正文起点段 {r['body_start']}，输出文章 {r['articles']} 篇")
        lines.append(f"- 目录期望 {r['expected']} 篇，正文匹配 {r['matched']} 篇")
        if r['unmatched']:
            lines.append(f"- ⚠️ 目录有而正文未匹配（{sum(r['unmatched'].values())}）：" + '、'.join(list(r['unmatched'])[:20]))
        if r['heuristic']:
            lines.append(f"- ⚠️ 启发式识别标题（目录未列，{len(r['heuristic'])}）：" + '、'.join(t for t, _, _ in r['heuristic'][:20]) + ('…' if len(r['heuristic']) > 20 else ''))
        if r['fuzzy']:
            lines.append(f"- ⚠️ 容错匹配（复/与互换、简称↔全称，{len(r['fuzzy'])}）：" + '、'.join(r['fuzzy'][:12]))
        if r['untitled']:
            lines.append(f"- ⚠️ 无标题行内容已收为〔无题〕文章（{len(r['untitled'])} 段起点）：" + '；'.join(f'段{i}「{t}…」' for i, t in r['untitled'][:8]))
        if r['no_trans']:
            lines.append(f"- ⚠️ 无译文篇目（{len(r['no_trans'])}）：" + '、'.join(a['title'] for a in r['no_trans'][:15]) + ('…' if len(r['no_trans']) > 15 else ''))
        if r['mismatch']:
            lines.append(f"- ⚠️ 原文/译文段数不等（{len(r['mismatch'])} 篇，对照视图将降级为分块显示）：")
            for art, po, pt in r['mismatch'][:15]:
                lines.append(f"    - {art['title']}（原{po}段/译{pt}段）")
            if len(r['mismatch']) > 15:
                lines.append(f"    - …等共 {len(r['mismatch'])} 篇")
        lines.append(f"- 原文区非粗体异常段：{r['anomalies']}")
    if report['stray']:
        lines.append(f"\n## 游离段落（未归入任何文章，共 {len(report['stray'])}）")
        for vid, i, t in report['stray'][:30]:
            lines.append(f"- [{vid}:{i}] {t}")
    rpt = Path(__file__).resolve().parent / 'report.md'
    rpt.write_text('\n'.join(lines), encoding='utf-8')
    print(f'完成：{total} 篇 → {OUT}')
    print(f'报告：{rpt}')


if __name__ == '__main__':
    main()
