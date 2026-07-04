#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
嘉言录 ↔ 文钞 双链构建（幂等，可重复运行）

正向：嘉言录条目出处 seg.src（如「卷三·序·重刻阿弥陀经序」）
      → 解析并匹配增广文钞篇目 → 写入 seg.srcId
反向：被引用的文钞篇目 → 写入 backrefs: [{a:嘉言录篇id, t:篇题, n:条数}]

匹配容错（与 convert 时代一致的策略）：原样 → 去括注 → 复/与互换 →
前后缀包含。未解决者如实列入报告，不强行匹配。

增广文钞中存在同名文章（如"复永嘉某居士书一"因收信人/批次不同，重名达2~3篇），
题名索引按候选列表存放，命中多个候选时以条目原文片段做内容验证消歧，
仍无法唯一确定的，保留旧行为（取第一候选）但计入 ambiguous 报告以便人工复核。

运行顺序：parse → migrate → link_src →（如有需要）build_search
"""
import json
import os
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(PROJ, 'site', 'data')

JUAN_VOL = {'卷一': 'zg1', '卷二': 'zg1', '卷三': 'zg2', '卷四': 'zg2'}

# 已人工核实的出处标注错误：底本引用的篇名本身就是错的（非仅编号误差、
# 也非同名混淆），自动消歧/内容纠正机制覆盖不到，逐条列出以便未来
# 重新生成数据时仍保持修正。key=(嘉言录篇id, segments下标)，value=正确 aid。
MANUAL_FIX = {
    # jy-027《丙、劝处家宏法》第2条：标注"复周孟由昆弟书"，
    # 内容经与文钞全集核对，实为《复永嘉某居士昆季书》（收信人不同的另一封信）。
    ('jy-027', 1): 'zg1-029',
}


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


def content_norm(s):
    """内容比对专用：只保留汉字/字母/数字，标点、引号、书名号排版差异一律忽略"""
    return re.sub(r'[^一-鿿0-9A-Za-z]', '', s)


def main():
    books = json.load(open(os.path.join(DATA, 'books.json'), encoding='utf-8'))
    # 增广上下册篇名索引（同名文章按候选列表存放，去重）
    title_map = {'zg1': {}, 'zg2': {}}
    loose_map = {'zg1': {}, 'zg2': {}}

    def add_cand(idx, key, aid):
        lst = idx.setdefault(key, [])
        if aid not in lst:
            lst.append(aid)

    for b in books:
        if b['id'] not in title_map:
            continue
        for j in b['juans']:
            for c in j['cats']:
                for it in c['items']:
                    for key in {norm(it['title']), norm(strip_parens(it['title']))}:
                        add_cand(title_map[b['id']], key, it['id'])
                    for key in {loose(norm(it['title'])), loose(norm(strip_parens(it['title'])))}:
                        add_cand(loose_map[b['id']], key, it['id'])

    def art_text(aid):
        a = json.load(open(os.path.join(DATA, 'articles', aid + '.json'), encoding='utf-8'))
        return content_norm(''.join(p for s in a['segments'] for p in s['orig']))

    ambiguous = []   # (t, snippet, cands) 命中多候选但内容验证未能唯一消歧

    def coverage(snippet, text):
        if not snippet:
            return 0.0
        sm = SequenceMatcher(None, snippet, text, autojunk=False)
        return sum(b.size for b in sm.get_matching_blocks()) / len(snippet)

    def pick(t, cands, snippet):
        """候选唯一直接返回；多候选时用条目原文全文（去标点）做相似度消歧，
        避免逗号/句号/引号等排版差异导致误判为无法消歧"""
        if len(cands) <= 1:
            return cands[0] if cands else None
        if snippet:
            scored = sorted(((coverage(snippet, art_text(c)), c) for c in cands), reverse=True)
            top, second = scored[0], (scored[1] if len(scored) > 1 else (0.0, None))
            if top[0] >= 0.9 and top[0] - second[0] >= 0.2:
                return top[1]
        ambiguous.append((t, (snippet or '')[:20], list(cands)))
        return cands[0]

    def lookup(vol, t, snippet=None):
        """在某册（zg1/zg2）篇名索引里容错匹配题名 → id（同名候选按内容消歧）"""
        t = norm(t)
        m = title_map[vol]
        for cand in (t, norm(strip_parens(t))):
            if cand in m:
                return pick(cand, m[cand], snippet)
            # 复/与 用字互换（底本不一致，沿用既有容错策略）
            if cand[:1] in ('复', '与'):
                sw = ('与' if cand[0] == '复' else '复') + cand[1:]
                if sw in m:
                    return pick(sw, m[sw], snippet)
        # 宽松形（顿逗号/"居士"/末尾编号差异），含编号回落（书→书一/书二）
        lt = loose(t)
        lm = loose_map[vol]
        if lt in lm:
            return pick(lt, lm[lt], snippet)
        for suffix in ('一', '二'):
            if lt + suffix in lm:
                return pick(lt + suffix, lm[lt + suffix], snippet)
        # 前后缀包含与字符子序列（简称 ↔ 全称）
        for k, v in m.items():
            if len(t) >= 6 and (k.endswith(t) or (t.endswith(k) and len(k) >= 6) or subseq(t, k)):
                return pick(k, v, snippet)
        return None

    def resolve(src, snippet=None):
        parts = src.split('·')
        if len(parts) < 3:
            return None
        vol = JUAN_VOL.get(norm(parts[0]))
        if not vol:
            return None
        return lookup(vol, '·'.join(parts[2:]), snippet)

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
        for si, seg in enumerate(art['segments']):
            src = seg.get('src')
            if not src:
                continue
            if (art['id'], si) in MANUAL_FIX:
                rid = MANUAL_FIX[(art['id'], si)]
                if seg.get('srcId') != rid:
                    changed = True
                seg['srcId'] = rid
                resolved += 1
                backrefs[rid][(art['id'], art['title'])] += 1
                continue
            full_snippet = content_norm(''.join(seg.get('orig', [])))
            rid = resolve(src, full_snippet)
            if rid and full_snippet and coverage(full_snippet, art_text(rid)) < 0.3:
                # 标题能唯一匹配到某篇，但内容覆盖率过低——多半是底本出处编号本身标错
                # （如"书一"实为"书二"），按内容在全站范围内做纠正性回退
                fixed = resolve_by_content(src, full_snippet[:20])
                if fixed and fixed != rid and coverage(full_snippet, art_text(fixed)) >= 0.9:
                    cross.append(f'{src} → {rid}（题名命中但内容不符，按内容纠正为 {fixed}）')
                    rid = fixed
            if not rid:
                rid = resolve_by_content(src, full_snippet[:20])
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
    if ambiguous:
        print(f'同名候选未能唯一消歧（取第一候选，需人工复核）：{len(ambiguous)} 处')
        for t, snippet, cands in ambiguous:
            print(f'  {t}  候选={cands}  片段="{snippet}"')
    print(f'反向链接：{n_back} 篇文钞文章已标注被嘉言录引用')
    print(f'选读篇目链接：{xd_hit} 条 → 文钞，{xd_miss} 条未匹配（保留纯文字）')


if __name__ == '__main__':
    main()
