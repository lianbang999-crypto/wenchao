# -*- coding: utf-8 -*-
"""
印光法师文钞（白话版底本）docx → 实验模型 JSON 解析器 · 主项目版
源自 -2025/scripts/parse_wenchao.py，扩展支持 03-07 的结构形态：
  - 卷/类别标记可为普通行（03/04 卷、05/06 类别）或 Heading 1（03 跋、
    04/06 附录、05/06 卷、07 类别）
  - 普通行标记仅在「目次之后」生效（marks_after_title），避免误吃
    Word 自动目录与书内目次的同名行
  - 07 无目次 H1：plain_skip_titles 指定的普通行起、至下一个 H1 止，
    整段跳过（书内目次誊录区）
通用规律：Heading 1=篇标题；粗体段=原文、非粗体段=白话，通常逐段配对；
注释段 [n]【术语】… 按原位置存放。
校验：逐篇将 JSON 重建文本流与文档原文逐字比对（忽略空白），必须一致。

用法: python3 parse_v2.py 03   （输出 → build/{vol}/ 与 build/reports/）
"""
import bisect
import json
import os
import re
import sys

import docx

BASE = "/Users/bincai/Downloads/印光法师文钞word"
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NOTE_RE = re.compile(r'^\[(\d+)\]\s*(.+)$', re.S)
TRANSLATOR_RE = re.compile(r'^[一-鿿、，·\s]{2,28}(译|谨记|记|校审)$')
SUMMARY_RE = re.compile(r'^【提要】\s*(.*)$')


def squash(s):
    return re.sub(r'[\s　]+', '', s)


# ---------------- 各册配置 ----------------
VOLUMES = {
    "03": {
        "src": "03印光法师文钞续编上册--白话20250211.docx",
        "title": "印光法师文钞续编 上册",
        "juan_re": re.compile(r'^印光法师文钞续编卷上$'),
        "juan_label": lambda m: "卷上",
        "default_cat": lambda m: "书",
        "cats": {"书", "跋"},
        "front_part": "卷首",
        "skip_titles": {"印光法师文钞续编卷上目次"},
        "marks_after_title": "印光法师文钞续编卷上目次",
        "plain_skip_titles": set(),
    },
    "04": {
        "src": "04印光法师文钞续编下册--白话20250228.docx",
        "title": "印光法师文钞续编 下册",
        "juan_re": re.compile(r'^印光法师文钞续编卷下$'),
        "juan_label": lambda m: "卷下",
        "default_cat": lambda m: "序",
        "cats": {"序", "记", "疏", "跋", "杂著", "颂", "赞", "颂赞", "楹联", "附录", "法语"},
        "front_part": "",
        "skip_titles": {"印光法师文钞续编卷下目次"},
        "marks_after_title": "印光法师文钞续编卷下目次",
        "plain_skip_titles": set(),
    },
    "05": {
        "src": "05印光法师文钞三编上册--白话20250307.docx",
        "title": "印光法师文钞三编 上册",
        "juan_re": re.compile(r'^印光法师文钞三编卷第([一二])$'),
        "juan_label": lambda m: "卷" + m.group(1),
        "default_cat": lambda m: "书" + m.group(1),
        "cats": {"书一", "书二"},
        "cat_juan": {"书一": "卷一", "书二": "卷二"},  # 书二无卷第二标题行，由类别定卷
        "front_part": "卷首",
        "skip_titles": {"印光法师文钞三编上册目次"},
        "marks_after_title": "印光法师文钞三编上册目次",
        "plain_skip_titles": set(),
    },
    "06": {
        "src": "06印光法师文钞三编下册--白话20250305.docx",
        "title": "印光法师文钞三编 下册",
        "juan_re": re.compile(r'^印光法师文钞三编卷第([三四])$'),
        "juan_label": lambda m: "卷" + m.group(1),
        "default_cat": lambda m: "书" + m.group(1) if m.group(1) == "三" else "",
        "cats": {"书三", "书四", "论", "序", "记", "疏", "杂著", "颂", "赞", "颂赞",
                 "附录", "法语", "开示", "问答", "楹联"},
        "front_part": "",
        "skip_titles": {"印光法师文钞三编下册目次"},
        "marks_after_title": "印光法师文钞三编下册目次",
        "plain_skip_titles": set(),
    },
    "07": {
        "src": "07印光法师文钞三编补--白话20250320.docx",
        "title": "印光法师文钞三编补",
        "juan_re": re.compile(r'^印光法师文钞三编补$'),
        "juan_label": lambda m: "",
        "default_cat": lambda m: "",
        "cats": {"书信", "法语开示", "序跋疏", "偈颂愿文对联", "传记记事祭文",
                 "论文", "附录", "杂记", "颂赞", "序跋", "疏", "传记", "祭文"},
        "front_part": "卷首",
        "skip_titles": set(),
        "marks_after_title": None,   # 无目次 H1，普通行标记从首个类别 H1 之后生效
        "plain_skip_titles": {"印光法师文钞三编补目次"},
    },
}


def para_bold(p):
    """按字符数判断段落是否整体为粗体"""
    bc = tc = 0
    for r in p.runs:
        t = r.text.strip()
        if not t:
            continue
        tc += len(t)
        if r.bold:
            bc += len(t)
    return tc > 0 and bc / tc >= 0.5


def split_mixed(p):
    """粗体混排段：拆为（粗体前缀=原文，非粗体后缀=白话）"""
    bold_part, plain_part = [], []
    seen_plain = False
    for r in p.runs:
        if not r.text:
            continue
        if r.bold and not seen_plain:
            bold_part.append(r.text)
        else:
            seen_plain = True
            plain_part.append(r.text)
    o = "".join(bold_part).strip()
    t = "".join(plain_part).strip()
    if len(o) >= 10 and len(t) >= 10:
        return o, t
    return None


def marker_kind(cfg, text):
    """结构标记：('juan', m) / ('cat', 类别名) / None（按去空格文本匹配）"""
    sq = squash(text)
    if not sq or len(sq) > 14:
        return None
    m = cfg["juan_re"].match(sq)
    if m:
        return ("juan", m)
    if sq in cfg["cats"]:
        return ("cat", sq)
    return None


def parse_volume(vol):
    cfg = VOLUMES[vol]
    src = os.path.join(BASE, cfg["src"])
    out_dir = os.path.join(PROJ, "build", vol)
    report_path = os.path.join(PROJ, "build", "reports", f"report_{vol}.txt")
    os.makedirs(os.path.join(out_dir, "articles"), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)

    d = docx.Document(src)
    paras = d.paragraphs
    h1_idx = [i for i, p in enumerate(paras) if p.style.name == "Heading 1"]

    # 普通行结构标记的生效起点：书内目次 H1 之后（07 用首个类别 H1）
    marks_after = 0
    if cfg["marks_after_title"]:
        for i in h1_idx:
            if squash(paras[i].text.strip().split("\n")[0]) == squash(cfg["marks_after_title"]):
                marks_after = i
                break
    elif vol == "07":
        for i in h1_idx:
            if marker_kind(cfg, paras[i].text.strip().split("\n")[0]):
                marks_after = i
                break

    # 普通行目次区跳过范围（07）：从指定普通行起至下一个 H1
    skip_ranges = []
    for i, p in enumerate(paras):
        if squash(p.text.strip()) in {squash(x) for x in cfg["plain_skip_titles"]}:
            pos = bisect.bisect_right(h1_idx, i)
            nxt = h1_idx[pos] if pos < len(h1_idx) else len(paras)
            skip_ranges.append((i, nxt))

    def in_skip(i):
        return any(a <= i < b for a, b in skip_ranges)

    # ---- 收集结构标记：H1 标记 + 目次后的"干净"普通行标记 ----
    h1_markers = {}   # 段索引 → ('juan'|'cat', ...)
    for i in h1_idx:
        mk = marker_kind(cfg, paras[i].text.strip().split("\n")[0])
        if mk:
            h1_markers[i] = mk

    body_marks = []   # (位置, 分部名)
    cur_juan = ""
    all_marks = []    # (位置, mk)
    for i, p in enumerate(paras):
        t = p.text.strip()
        if i in h1_markers:
            all_marks.append((i, h1_markers[i]))
            continue
        if i < marks_after or in_skip(i):
            continue
        mk = marker_kind(cfg, t)
        if not mk:
            continue
        pos = bisect.bisect_right(h1_idx, i)
        nxt = h1_idx[pos] if pos < len(h1_idx) else len(paras)
        clean = True
        for j in range(i + 1, nxt):
            tj = paras[j].text.strip()
            if tj and not marker_kind(cfg, tj):
                clean = False
                break
        if clean:
            all_marks.append((i, mk))
    all_marks.sort(key=lambda x: x[0])
    for i, mk in all_marks:
        if mk[0] == "juan":
            cur_juan = cfg["juan_label"](mk[1])
            cat = cfg["default_cat"](mk[1])
        else:
            cat = mk[1]
            cur_juan = cfg.get("cat_juan", {}).get(cat, cur_juan)
        name = (cur_juan + " · " + cat) if (cur_juan and cat) else (cur_juan or cat)
        body_marks.append((i, name))

    report = [f"源文件: {cfg['src']}",
              f"总段落: {len(paras)}  Heading1: {len(h1_idx)}",
              f"分部标记: {[t for _, t in body_marks]}"]

    articles, anomalies = [], []
    bounds = list(zip(h1_idx, h1_idx[1:] + [len(paras)]))
    art_no = 0
    skip_sq = {squash(x) for x in cfg["skip_titles"]}

    for s, e in bounds:
        raw_title = paras[s].text.strip()
        if not raw_title or squash(raw_title.split("\n")[0]) in skip_sq or s in h1_markers:
            continue
        art_no += 1
        title_lines = [ln.strip() for ln in raw_title.split("\n") if ln.strip()]
        title = title_lines[0]
        translator = ""
        for extra in title_lines[1:]:
            if TRANSLATOR_RE.match(extra):
                translator = extra
            else:
                anomalies.append(f"[{title}] 标题内嵌未识别行: {extra}")

        # 无粗体文章（如三编补"序跋疏"以后、续编个别序）：底本以
        # 空行分组、组内前半原文后半白话。偶数组对半切分，并以"的"字
        # 密度验证后半确为白话；不合者整组按白话并记入报告。
        # 注：结构行/注释区头/注释条目的粗体不算内容粗体
        def content_bold(i):
            p2 = paras[i]
            t2 = p2.text.strip()
            if not t2 or marker_kind(cfg, t2) or NOTE_RE.match(t2):
                return False
            if re.sub(r'[\s　]+', '', t2) in ('【注释】', '注释', '【注：】', '注：', '【注】'):
                return False
            return para_bold(p2)

        has_bold = any(content_bold(i) for i in range(s + 1, e))
        if not has_bold:
            segments = []
            groups, g = [], []
            for i in range(s + 1, e):
                if in_skip(i):
                    continue
                text = paras[i].text.strip()
                if not text:
                    if g:
                        groups.append(g)
                        g = []
                    continue
                if marker_kind(cfg, text):
                    continue
                m = NOTE_RE.match(text)
                if m:
                    if g:
                        groups.append(g)
                        g = []
                    groups.append(('note', int(m.group(1)), m.group(2).strip()))
                    continue
                g.append(text)
            if g:
                groups.append(g)

            # 白话虚词密度（文言近零；避开文言常用的"了"，如"了生死"）
            MARKERS = ('的', '这', '吗', '呢', '啊', '们', '您',
                       '已经', '因为', '所以', '就是', '什么')

            def score(ps):
                if isinstance(ps, str):
                    ps = [ps]
                total = sum(len(x) for x in ps) or 1
                return sum(x.count(m) for x in ps for m in MARKERS) / total

            n_pair = n_fallback = 0
            for grp in groups:
                if isinstance(grp, tuple):
                    segments.append({"n": grp[1], "note": grp[2]})
                    continue
                n = len(grp)
                if n >= 2 and n % 2 == 0:
                    ev, od = grp[0::2], grp[1::2]
                    # 交替式（原白原白…）：奇数位显著更白话
                    if score(od) >= 0.006 and score(od) > 2 * score(ev):
                        for o, t in zip(ev, od):
                            segments.append({"o": o, "t": t})
                        n_pair += 1
                        continue
                    # 对半式（前半原文后半白话）
                    h = n // 2
                    if score(grp[h:]) >= 0.006 and score(grp[h:]) > 2 * score(grp[:h]):
                        segments.append({"os": grp[:h], "ts": grp[h:]})
                        n_pair += 1
                        continue
                # 不成对：逐段归类——显式"译文："前缀与年月落款优先，
                # 其余按虚词密度（对联/偈→原文，前言类→白话）
                for x in grp:
                    if x.startswith(('译文：', '译文:')) or re.match(r'^\d{4}年|^[（(]?民国|^[一-鿿]{2,6}弟子$', x):
                        segments.append({"t": x})
                    else:
                        segments.append({"t": x} if score(x) >= 0.006 else {"o": x})
                n_fallback += 1
            if n_pair or n_fallback:
                anomalies.append(f"[{title}] 无粗体·空行配对：成对{n_pair}组，逐段归类{n_fallback}组")
            part = cfg["front_part"]
            for mi, mt in body_marks:
                if mi < s:
                    part = mt
            articles.append({
                "id": f"{art_no:03d}", "title": title, "translator": translator,
                "summary": "", "part": part, "segments": segments,
                "_range": (s, e),
            })
            continue

        summary = ""
        segments = []
        obuf, tbuf = [], []

        def commit():
            nonlocal obuf, tbuf
            if not obuf and not tbuf:
                return
            M, N = len(obuf), len(tbuf)
            if M and N:
                k = min(M, N)
                for x in obuf[:M - k]:
                    segments.append({"o": x})
                if k >= 2:
                    segments.append({"os": obuf[M - k:], "ts": tbuf[:k]})
                    anomalies.append(f"[{title}] 连排对照块 {M}x{N} 已按位配对: {obuf[M-k][:16]}...")
                else:
                    segments.append({"o": obuf[-1], "t": tbuf[0]})
                for x in tbuf[k:]:
                    segments.append({"t": x})
            elif M:
                for x in obuf:
                    segments.append({"o": x})
            else:
                for x in tbuf:
                    segments.append({"t": x})
            obuf, tbuf = [], []

        for i in range(s + 1, e):
            if in_skip(i):
                continue
            p = paras[i]
            text = p.text.strip()
            if not text or marker_kind(cfg, text):
                continue
            in_note_block = (not obuf and not tbuf
                             and bool(segments) and "n" in segments[-1])
            bold = para_bold(p)
            m = NOTE_RE.match(text)
            if m:
                commit()
                segments.append({"n": int(m.group(1)), "note": m.group(2).strip()})
                continue
            if in_note_block and not bold and text != "【注释】":
                segments[-1]["note"] += "\n" + text
                continue
            sm = SUMMARY_RE.match(text)
            if sm and not segments and not obuf and not tbuf:
                summary = sm.group(1).strip()
                continue
            bolds = {bool(r.bold) for r in p.runs if r.text.strip()}
            if len(bolds) > 1:
                sp = split_mixed(p)
                if sp:
                    commit()
                    segments.append({"o": sp[0], "t": sp[1]})
                    anomalies.append(f"[{title}] 混排段已拆分: {sp[0][:20]}...")
                    continue
            if bold:
                if tbuf:
                    commit()
                obuf.append(text)
            else:
                tbuf.append(text)
        commit()

        part = cfg["front_part"]
        for mi, mt in body_marks:
            if mi < s:
                part = mt
        articles.append({
            "id": f"{art_no:03d}", "title": title, "translator": translator,
            "summary": summary, "part": part, "segments": segments,
            "_range": (s, e),
        })

    # ---- 统计 ----
    def seg_counts(a):
        pr = oo = tt = nn = 0
        for g in a["segments"]:
            if "n" in g:
                nn += 1
            elif "os" in g:
                pr += len(g["os"])
            elif "o" in g and "t" in g:
                pr += 1
            elif "o" in g:
                oo += 1
            else:
                tt += 1
        return pr, oo, tt, nn

    tot = [0, 0, 0, 0]
    for a in articles:
        for k, v in enumerate(seg_counts(a)):
            tot[k] += v
    report.append(f"\n解析出文章数: {len(articles)}")
    report.append(f"文白配对段: {tot[0]}  独立原文段: {tot[1]}  独立白话段: {tot[2]}  注释: {tot[3]}")

    # ---- 逐篇精确对账 ----
    def sq_all(x):
        return re.sub(r'\s+', '', x)

    diffs = []
    for a in articles:
        s, e = a["_range"]
        doc_stream = []
        for i in range(s + 1, e):
            if in_skip(i):
                continue
            t = paras[i].text.strip()
            if not t or marker_kind(cfg, t):
                continue
            doc_stream.append(t)
        json_stream = []
        if a["summary"]:
            json_stream.append("【提要】" + a["summary"])
        for g in a["segments"]:
            if "n" in g:
                json_stream.append(f"[{g['n']}]" + g["note"])
            elif "os" in g:
                json_stream.extend(g["os"])
                json_stream.extend(g["ts"])
            else:
                if "o" in g:
                    json_stream.append(g["o"])
                if "t" in g:
                    json_stream.append(g["t"])
        d_sq, j_sq = sq_all("".join(doc_stream)), sq_all("".join(json_stream))
        if d_sq != j_sq:
            pos = next((k for k in range(min(len(d_sq), len(j_sq))) if d_sq[k] != j_sq[k]),
                       min(len(d_sq), len(j_sq)))
            diffs.append(f"{a['id']} {a['title'][:20]} 文档{len(d_sq)}字/JSON{len(j_sq)}字 "
                         f"首分歧@{pos}: 文档[...{d_sq[max(0,pos-8):pos+12]}] JSON[...{j_sq[max(0,pos-8):pos+12]}]")
    if diffs:
        report.append(f"\n⚠ 对账不一致的文章 {len(diffs)} 篇:")
        report.extend("  " + x for x in diffs)
    else:
        report.append(f"逐篇对账: 全部 {len(articles)} 篇 JSON 与文档原文逐字一致 ✓")

    # ---- 每篇概况 ----
    report.append("\n--- 每篇概况 ---")
    for a in articles:
        pr, oo, tt, nn = seg_counts(a)
        flags = []
        if oo > 2:
            flags.append(f"独立原文段x{oo}")
        if tt > 2:
            flags.append(f"独立白话段x{tt}")
        line = f"{a['id']} {a['title'][:24]:<26} 对{pr:>3} 原{oo} 白{tt} 注{nn}  [{a['part']}]"
        if flags:
            line += "  ⚠ " + "; ".join(flags[:2])
        report.append(line)
    if anomalies:
        report.append("\n--- 处理记录 ---")
        report.extend(anomalies)

    # ---- 输出 ----
    parts = []
    for a in articles:
        pt = a["part"] or "其他"
        if not parts or parts[-1]["title"] != pt:
            parts.append({"title": pt, "articles": []})
        parts[-1]["articles"].append({"id": a["id"], "title": a["title"], "summary": a["summary"]})
    index = {"id": vol, "title": cfg["title"], "parts": parts, "count": len(articles)}
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    for a in articles:
        out = {k: v for k, v in a.items() if not k.startswith("_")}
        with open(os.path.join(out_dir, "articles", a["id"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(report))
    print("\n".join(report[:6]))
    if diffs:
        print(f"⚠ 对账不一致 {len(diffs)} 篇，详见报告")
    else:
        print(f"逐篇对账全部一致 ✓ 共 {len(articles)} 篇")
    print(f"报告: {report_path}")


if __name__ == "__main__":
    parse_volume(sys.argv[1] if len(sys.argv) > 1 else "03")
