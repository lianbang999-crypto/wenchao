# -*- coding: utf-8 -*-
"""
《印光法师嘉言录》白话（东林寺文库）docx → 实验模型 JSON

体例（已探查验证）：
  - 十编主题标题 = Normal 样式短行（一、赞净土超胜 …… 十、标应读典籍）
  - 子节 = 甲、乙、丙… 短行；无子节的编整编为一篇
  - 条目 = 【原文】段（可多段）+【译文】段（可多段），逐条对照
  - Body Text 样式行均为页眉页码（"编名 · 15 ·"、"· 2 书名 白话"、"目录 N"），过滤
  - 书首：印光法师语 / 封面题词 / 封二题词等小品；书尾：东林寺附录
铁律：只切分、过滤版式噪音，不改一字；逐篇对账（忽略空白）必须一致。

输出：build/jy/{index.json, articles/}，条目存为 {os:[原文段], ts:[译文段]}，
      与 migrate_v2.py 衔接（os/ts 等长则前端逐段对照，不等则分块）。
"""
import json
import os
import re

import docx

SRC = '/Users/bincai/Downloads/印光法师文钞word/嘉言录菁华录等/03印光法师嘉言录白话（东林寺文库）2023.11.26.docx'
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(PROJ, 'build', 'jy')
REPORT = os.path.join(PROJ, 'build', 'reports', 'report_jy.txt')

# 十编（原书目次，白名单精确匹配）
BIAN = ['一、赞净土超胜', '二、诫信愿真切', '三、示修持方法', '四、论生死事大',
        '五、勉居心诚敬', '六、告注重因果', '七、分禅净界限', '八、释普通疑惑',
        '九、谕在家善信', '十、标应读典籍']
RE_SUB = re.compile(r'^[甲乙丙丁戊己庚辛]、.{2,12}$')      # 子节
# 条目出处行：卷三·序·重刻阿弥陀经序（全书 434 条，结构化为 src）
RE_SRC = re.compile(r'^卷[一二三四]·[^·]{1,6}·.{2,24}$')
# 书尾锚点标题 → 所属分部
ANCHORS = {'修订说明': '附录', '东林佛号曲谱': '附录', '念佛的心态与音声': '附录', '回向偈': '附录'}
RE_JUNK = [
    re.compile(r'·\s*\d+\s*·'),          # 页眉：编名 · 15 ·
    re.compile(r'^·\s*\d+\s+'),          # 页眉：· 2  书名 白话
    re.compile(r'^\d+\s*·\s'),            # 页眉：224 ·  书名 白话
    re.compile(r'^目录\s*\d*$'),
    re.compile(r'^\d+\s*$'),              # 纯页码
    re.compile(r'^附\s*录\s*[.·]\s*\d+$'),  # 页眉：附 录 . 483
    re.compile(r'^增附\s*\d+$'),           # 页眉：增附 469
    re.compile(r'^0\d{2,3}-\d{6,8}$'),     # 版权页电话
    re.compile(r'^[\w.]+@[\w.]+$'),        # 版权页邮箱
    re.compile(r'^庐山东林寺官方平台$'),
]


def is_junk(t, style):
    if any(r.search(t) for r in RE_JUNK):
        return True
    return False


RE_CJK_GAP = re.compile(
    r'(?<=[一-鿿　-〿＀-￯])[ \t ]+'
    r'(?=[一-鿿　-〿＀-￯])')


def tidy(s):
    """清除汉字（含中文标点）之间的排版空格——东林本 PDF 转档遗留，
    非内容空白；对账忽略空白，不影响逐字一致性。"""
    return RE_CJK_GAP.sub('', s)


def main():
    d = docx.Document(SRC)
    paras = [(tidy(p.text.strip()), p.style.name) for p in d.paragraphs]

    # 正文起点：「嘉言录封面题词」且其后 6 段内出现【原文】
    body_start = None
    for i, (t, st) in enumerate(paras):
        if t == '嘉言录封面题词' and any(
                paras[j][0].startswith('【原文】') for j in range(i + 1, min(i + 7, len(paras)))):
            body_start = i
            break
    assert body_start, '未找到正文起点'

    # 书首「印光法师语」（目录之前的题词页）
    epigraph = []
    for i, (t, st) in enumerate(paras[:body_start]):
        if t == '印光法师语':
            j = i + 1
            while j < body_start and not re.match(r'^目录', paras[j][0]):
                if paras[j][0] and not is_junk(*paras[j]):
                    epigraph.append(paras[j][0])
                j += 1
            break

    articles = []          # {title, part, plain:[前置段], entries:[{os,ts}]}
    report = [f'源文件: {os.path.basename(SRC)}', f'总段落: {len(paras)}  正文起点: {body_start}']
    dropped = []           # 被过滤的版式行（抽样记录）

    cur = None             # 当前文章
    part = '卷首'
    seen_bian = set()
    entry = None           # 当前条目 {'os':[], 'ts':[], src?}; side: 'o'|'t'
    side = 'o'
    stream = []            # 全局流水：按消费顺序记录每一行（对账用）
    skip_next = set()      # 拆行装饰头的后续行索引

    def flush_entry():
        nonlocal entry
        if entry and (entry['os'] or entry['ts']):
            cur['entries'].append(entry)
        entry = None

    def new_article(title, new_part=None):
        nonlocal cur, part, entry, side
        flush_entry()
        if cur and (cur['plain'] or cur['entries']):
            articles.append(cur)
        if new_part is not None:
            part = new_part
        cur = {'title': title, 'part': part, 'plain': [], 'entries': []}
        entry, side = None, 'o'

    if epigraph:
        cur = {'title': '印光法师语', 'part': '卷首', 'plain': epigraph, 'entries': []}
        articles.append(cur)
        cur = None

    for i in range(body_start, len(paras)):
        t, st = paras[i]
        if not t:
            continue
        if is_junk(t, st):
            if len(dropped) < 8:
                dropped.append(t[:24])
            continue
        # 同篇内重复出现的篇名行 = 分页题头，仅入流水、不入正文
        if cur is not None and t == cur['title']:
            stream.append(t)
            continue
        # 「附 录」分部行
        if re.sub(r'[\s　]+', '', t) == '附录' and len(seen_bian) == 10:
            part = '附录'
            stream.append(t)
            continue
        # 结构标题（编/子节不入流水，文档流同样排除）
        if t in BIAN:
            seen_bian.add(t)
            new_article(t, new_part=t)
            continue
        if RE_SUB.match(t) and st == 'Normal' and len(seen_bian) > 0 and len(seen_bian) < 10 + 1:
            # 子节：若当前编文章尚无内容，子节取代其成为文章
            if cur and cur['title'] == part and not cur['plain'] and not cur['entries']:
                cur['title'] = t
            else:
                new_article(t)
            continue
        # 「附 录」拆成两行的装饰头（"附"+"录"相邻单字行）：入流水、跳过
        if t == '附' and i + 2 < len(paras):
            nxt = next((j for j in range(i + 1, min(i + 3, len(paras))) if paras[j][0]), None)
            if nxt and paras[nxt][0] == '录':
                stream.append('附')
                part = '附录'
                skip_next.add(nxt)
                continue
        if i in skip_next:
            stream.append(t)
            continue
        stream.append(t)
        # 书尾锚点标题
        if t in ANCHORS:
            new_article(t, new_part=ANCHORS[t])
            continue
        # 原书「附」（编十之后的释疑附文）
        if t == '附' and len(seen_bian) == 10:
            new_article('附', new_part='增附')
            continue
        # 条目出处行（位于原文与译文之间）→ 结构化挂到当前条目，不冲洗
        if RE_SRC.match(t):
            if entry is not None:
                entry['src'] = t
            elif cur is not None:
                cur['plain'].append(t)
            continue
        # 条目标记
        if t.startswith('【原文】'):
            flush_entry()
            entry = {'os': [t[4:].strip()] if t[4:].strip() else [], 'ts': []}
            side = 'o'
            continue
        if t.startswith('【译文】'):
            if entry is None:
                entry = {'os': [], 'ts': []}
            side = 't'
            rest = t[4:].strip()
            if rest:
                entry['ts'].append(rest)
            continue
        # 书首/书尾的小品标题：短行、无标点、具题名特征（会先冲洗未结条目）
        no_punct = len(t) <= 24 and st == 'Normal' and not re.search(r'[。，；：？！】]', t)
        is_front_title = (part == '卷首' and no_punct
                          and re.search(r'(题词|序|跋|语|记)$', t))
        is_appendix_title = (part in ('附录', '增附') and no_punct
                             and (re.match(r'^[一二三四五六七八九十]、', t)
                                  or re.search(r'(后记|题词|序|跋)$', t)))
        if is_front_title or is_appendix_title:
            new_article(t, new_part='附录' if is_appendix_title else None)
            continue
        # 普通内容行
        if cur is None:
            new_article('〔无题〕')
        if entry is not None:
            (entry['os'] if side == 'o' else entry['ts']).append(t)
        else:
            cur['plain'].append(t)
    new_article('〔收尾〕')  # 冲掉最后一篇（占位篇无内容不会入列）

    # ---- 对账：重建文本流 vs 文档原文（忽略空白与版式行）----
    def sq(x):
        return re.sub(r'\s+', '', x)

    doc_stream = []
    for i in range(body_start, len(paras)):
        t, st = paras[i]
        if not t or is_junk(t, st) or t in BIAN:
            continue
        if RE_SUB.match(t) and st == 'Normal':
            continue
        doc_stream.append(t)
    d_sq, j_sq = sq(''.join(doc_stream)), sq(''.join(stream))
    if d_sq != j_sq:
        pos = next((k for k in range(min(len(d_sq), len(j_sq))) if d_sq[k] != j_sq[k]),
                   min(len(d_sq), len(j_sq)))
        report.append(f'⚠ 对账不一致：文档{len(d_sq)}字 / JSON{len(j_sq)}字')
        report.append(f'  首分歧@{pos}: 文档[…{d_sq[max(0,pos-10):pos+14]}] JSON[…{j_sq[max(0,pos-10):pos+14]}]')
    else:
        report.append(f'全书对账一致 ✓（{len(d_sq)} 字）')

    # ---- 输出（实验模型）----
    os.makedirs(os.path.join(OUT, 'articles'), exist_ok=True)
    parts, idx = [], 0
    report.append(f'\n文章数: {len(articles)}  过滤版式行示例: {dropped}')
    report.append('\n--- 每篇概况 ---')
    for a in articles:
        idx += 1
        aid = f'{idx:03d}'
        segs = []
        for p in a['plain']:
            segs.append({'o': p})
        for e in a['entries']:
            seg = {'os': e['os'], 'ts': e['ts']}
            if e.get('src'):
                seg['src'] = e['src']
            segs.append(seg)
        art = {'id': aid, 'title': a['title'], 'translator': '', 'summary': '',
               'part': a['part'], 'segments': segs}
        with open(os.path.join(OUT, 'articles', aid + '.json'), 'w', encoding='utf-8') as f:
            json.dump(art, f, ensure_ascii=False, separators=(',', ':'))
        if not parts or parts[-1]['title'] != (a['part'] or '其他'):
            parts.append({'title': a['part'] or '其他', 'articles': []})
        parts[-1]['articles'].append({'id': aid, 'title': a['title'], 'summary': ''})
        n_pair = sum(1 for e in a['entries'] if len(e['os']) == len(e['ts']))
        report.append(f"{aid} {a['title'][:20]:<22} 条目{len(a['entries']):>3}（等长{n_pair}） 前置段{len(a['plain'])}  [{a['part']}]")
    index = {'id': 'jy', 'title': '印光法师嘉言录（白话）', 'parts': parts, 'count': len(articles)}
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(report))
    print('\n'.join(report[:6]))
    print(f'报告: {REPORT}')


if __name__ == '__main__':
    main()
