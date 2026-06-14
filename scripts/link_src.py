#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
嘉言录 ↔ 文钞 双链构建（幂等，可重复运行）

正向：嘉言录条目出处 seg.src（如「卷三·序·重刻阿弥陀经序」）
      → 解析并匹配增广文钞篇目 → 写入 seg.srcId
反向：被引用的文钞篇目 → 写入 backrefs: [{a:嘉言录篇id, t:篇题, n:条数}]

匹配容错（与 convert 时代一致的策略）：原样 → 去括注 → 复/与互换 →
前后缀包含。未解决者如实列入报告，不强行匹配。

运行顺序：parse → migrate → link_src →（如有需要）build_search
"""
import json
import os
import re
from collections import Counter, defaultdict

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(PROJ, 'site', 'data')

JUAN_VOL = {'卷一': 'zg1', '卷二': 'zg1', '卷三': 'zg2', '卷四': 'zg2'}


def norm(s):
    # 去空白与书名号/引号（增广篇名不用《》，去掉可让"《X》序"匹配"X序"）
    return re.sub(r'[\s　《》「」『』〈〉]+', '', s)


def strip_parens(s):
    return re.sub(r'（[^）]*）', '', s)


def loose(s):
    """宽松形：去顿逗逗括号字符（保留括号内文字）、去"居士"、去末尾编号"""
    s = re.sub(r'[、，,（）()]', '', s)
    s = s.replace('居士', '')
    return re.sub(r'[一二三四五六七八九十]+$', '', s)


def subseq(short, long_):
    """short 的字符按序出现在 long_ 中（简称↔全称），且末字相同"""
    if len(short) < 6 or short[-1] != long_[-1]:
        return False
    it = iter(long_)
    return all(ch in it for ch in short)


def main():
    books = json.load(open(os.path.join(DATA, 'books.json'), encoding='utf-8'))
    # 增广上下册篇名索引
    title_map = {'zg1': {}, 'zg2': {}}
    loose_map = {'zg1': {}, 'zg2': {}}
    for b in books:
        if b['id'] not in title_map:
            continue
        for j in b['juans']:
            for c in j['cats']:
                for it in c['items']:
                    title_map[b['id']].setdefault(norm(it['title']), it['id'])
                    title_map[b['id']].setdefault(norm(strip_parens(it['title'])), it['id'])
                    loose_map[b['id']].setdefault(loose(norm(it['title'])), it['id'])
                    loose_map[b['id']].setdefault(loose(norm(strip_parens(it['title']))), it['id'])

    def lookup(vol, t):
        """在某册（zg1/zg2）篇名索引里容错匹配题名 → id"""
        t = norm(t)
        m = title_map[vol]
        for cand in (t, norm(strip_parens(t))):
            if cand in m:
                return m[cand]
            # 复/与 用字互换（底本不一致，沿用既有容错策略）
            if cand[:1] in ('复', '与'):
                sw = ('与' if cand[0] == '复' else '复') + cand[1:]
                if sw in m:
                    return m[sw]
        # 宽松形（顿逗号/"居士"/末尾编号差异），含编号回落（书→书一/书二）
        lt = loose(t)
        lm = loose_map[vol]
        if lt in lm:
            return lm[lt]
        for suffix in ('一', '二'):
            if lt + suffix in lm:
                return lm[lt + suffix]
        # 前后缀包含与字符子序列（简称 ↔ 全称）
        for k, v in m.items():
            if len(t) >= 6 and (k.endswith(t) or (t.endswith(k) and len(k) >= 6) or subseq(t, k)):
                return v
        return None

    def resolve(src):
        parts = src.split('·')
        if len(parts) < 3:
            return None
        vol = JUAN_VOL.get(norm(parts[0]))
        if not vol:
            return None
        return lookup(vol, '·'.join(parts[2:]))

    # 跨册回落索引（全站所有篇目的宽松题名 → id 列表）
    all_loose = defaultdict(list)
    for b in books:
        for j in b['juans']:
            for c in j['cats']:
                for it in c['items']:
                    all_loose[loose(norm(it['title']))].append(it['id'])

    # 选读篇目 → 文钞链接：书信在增广上册(zg1)，论/疏/序/记/杂著在下册(zg2)
    SEC_VOL = {'卷一·书一': 'zg1', '卷二·书二': 'zg1'}

    def resolve_name(name, sec):
        base = re.sub(r'其[一二三四五六七八九十、，\s]+$', '', name).strip()
        primary = SEC_VOL.get(sec, 'zg2')
        for vol in (primary, 'zg2' if primary == 'zg1' else 'zg1'):
            rid = lookup(vol, base)
            if rid:
                return rid
        # 全站唯一宽松匹配回落；不唯一则不链（宁缺毋滥，不妄链）
        cands = list(dict.fromkeys(all_loose.get(loose(norm(base)), [])))
        return cands[0] if len(cands) == 1 else None

    def art_text(aid):
        a = json.load(open(os.path.join(DATA, 'articles', aid + '.json'), encoding='utf-8'))
        return norm(''.join(p for s in a['segments'] for p in s['orig']))

    def resolve_by_content(src, snippet):
        """卷号映射失败时跨册按题名回落，但必须以条目原文内容验证（不妄链）"""
        parts = src.split('·')
        t = loose(norm('·'.join(parts[2:]) if len(parts) >= 3 else parts[-1]))
        cands = []
        for key in (t,) + tuple(t + sfx for sfx in ('一', '二', '三')):
            cands.extend(all_loose.get(key, []))
        hits = [aid for aid in dict.fromkeys(cands) if snippet and snippet in art_text(aid)]
        return hits[0] if len(hits) == 1 else None

    # ---- 正向：嘉言录条目 → srcId ----
    backrefs = defaultdict(Counter)   # 文钞篇id → Counter[(嘉言录篇id, 篇题)]
    resolved = unresolved = 0
    cross = []
    missing = Counter()
    xd_hit = xd_miss = 0
    jy_files = sorted(f for f in os.listdir(os.path.join(DATA, 'articles')) if f.startswith('jy-'))
    for fn in jy_files:
        path = os.path.join(DATA, 'articles', fn)
        art = json.load(open(path, encoding='utf-8'))
        changed = False
        # 选读篇目 → 增广/续/三编 链接（组级：一名多封链首篇；歧义/无配留纯文字）
        for sec in art.get('xuandu', []):
            for it in sec['items']:
                rid = resolve_name(it['t'], sec['sec'])
                if it.get('aid') != rid:
                    changed = True
                if rid:
                    it['aid'] = rid
                    xd_hit += 1
                else:
                    it.pop('aid', None)
                    xd_miss += 1
        for seg in art['segments']:
            src = seg.get('src')
            if not src:
                continue
            rid = resolve(src)
            if not rid:
                snippet = norm(seg['orig'][0])[:20] if seg.get('orig') else ''
                rid = resolve_by_content(src, snippet)
                if rid:
                    cross.append(f'{src} → {rid}（内容已验证）')
            if seg.get('srcId') != rid:
                changed = True
            if rid:
                seg['srcId'] = rid
                resolved += 1
                backrefs[rid][(art['id'], art['title'])] += 1
            else:
                seg.pop('srcId', None)
                unresolved += 1
                missing[src] += 1
        if changed:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(art, f, ensure_ascii=False)

    # ---- 反向：文钞篇目 → backrefs（先清后写，保证幂等）----
    n_back = 0
    for vol in ('zg1', 'zg2'):
        for fn in sorted(f for f in os.listdir(os.path.join(DATA, 'articles')) if f.startswith(vol + '-')):
            path = os.path.join(DATA, 'articles', fn)
            art = json.load(open(path, encoding='utf-8'))
            old = art.pop('backrefs', None)
            aid = art['id']
            if aid in backrefs:
                art['backrefs'] = [
                    {'a': k[0], 't': k[1], 'n': v}
                    for k, v in sorted(backrefs[aid].items())
                ]
                n_back += 1
            if old != art.get('backrefs'):
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(art, f, ensure_ascii=False)

    print(f'正向链接：{resolved} 条解析成功，{unresolved} 条未解析')
    for x in cross:
        print('  跨册回落:', x)
    if missing:
        print('未解析出处（如实保留为纯文字）：')
        for s, n in missing.most_common(20):
            print(f'  x{n} {s}')
    print(f'反向链接：{n_back} 篇文钞文章已标注被嘉言录引用')
    print(f'选读篇目链接：{xd_hit} 条 → 文钞，{xd_miss} 条未匹配（保留纯文字）')


if __name__ == '__main__':
    main()
