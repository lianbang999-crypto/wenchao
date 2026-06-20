#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文钞 RAG 检索/回答质量评测（只依赖标准库）。

对线上 AI 接口逐题发问，解析 ndjson 流（meta/delta/done），统计：
  - 召回率 recall@k：标注了 expectArticles 的题中，返回 sources/passages 命中期望篇目的比例
  - 引用率：回答含 [n] 角标的比例（接地与否的代理指标）
  - 拒答率：回答为「文钞中未见相关开示」的比例
  - 平均出处数 / 平均检索段数

用法：
  python3 scripts/eval_rag.py                       # 打本机/线上默认端点
  python3 scripts/eval_rag.py --endpoint https://wenchao.foyue.org/api/ai
  python3 scripts/eval_rag.py --out scripts/eval_result.json --delay 1.5

注意：线上每 IP 每日限流（DAILY_LIMIT），题量大时分次跑或本地起 worker（wrangler dev）评测。
改动检索逻辑（worker.js）后重跑本脚本，对比 recall/引用率/拒答率的升降即可量化优化效果。
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

DEFAULT_ENDPOINT = "https://wenchao.foyue.org/api/ai"
REFUSAL_MARK = "未见相关开示"


def ask(endpoint, question, timeout=60):
    """发一题，返回 (reply, source_ids, passage_aids, status)。"""
    payload = json.dumps({"messages": [{"role": "user", "content": question}]}).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    reply, source_ids, passage_aids = "", [], []
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            buf = b""
            for chunk in resp:
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except Exception:
                        continue
                    t = obj.get("type")
                    if t == "meta":
                        source_ids = [s.get("id", "") for s in obj.get("sources", []) if s.get("id")]
                        passage_aids = [p.get("aid", "") for p in obj.get("passages", []) if p.get("aid")]
                    elif t == "delta":
                        reply += obj.get("text", "")
        return reply, source_ids, passage_aids, "ok"
    except urllib.error.HTTPError as e:
        return "", [], [], "http_%d" % e.code
    except Exception as e:  # noqa: BLE001
        return "", [], [], "err_%s" % type(e).__name__


def has_citation(reply):
    import re
    return bool(re.search(r"\[\d{1,2}\]", reply or ""))


def main():
    ap = argparse.ArgumentParser(description="文钞 RAG 评测")
    ap.add_argument("--endpoint", default=os.environ.get("WENCHAO_AI_ENDPOINT", DEFAULT_ENDPOINT))
    ap.add_argument("--questions", default=os.path.join(os.path.dirname(__file__), "eval_questions.json"))
    ap.add_argument("--out", default="")
    ap.add_argument("--delay", type=float, default=1.5, help="题间隔秒数，避免触发限流")
    args = ap.parse_args()

    data = json.load(open(args.questions, encoding="utf-8"))
    questions = data.get("questions", [])
    print("端点：%s" % args.endpoint)
    print("题数：%d\n" % len(questions))

    results = []
    n_recall_q = n_recall_hit = 0
    n_cite = n_refusal = n_ok = 0
    sum_sources = sum_passages = 0

    for i, q in enumerate(questions, 1):
        question = q.get("question", "")
        expect = [a for a in q.get("expectArticles", []) if a]
        reply, source_ids, passage_aids, status = ask(args.endpoint, question)
        found = set(source_ids) | set(passage_aids)
        hit = bool(expect) and any(a in found for a in expect)
        cited = has_citation(reply)
        refusal = REFUSAL_MARK in (reply or "")

        if status == "ok":
            n_ok += 1
            sum_sources += len(source_ids)
            sum_passages += len(passage_aids)
            if cited:
                n_cite += 1
            if refusal:
                n_refusal += 1
            if expect:
                n_recall_q += 1
                if hit:
                    n_recall_hit += 1

        mark = "  " if not expect else ("✓ " if hit else "✗ ")
        flag = "" if status == "ok" else "  [%s]" % status
        print("%s%2d. %s%s" % (mark, i, question, flag))
        print("     出处 %d · 段 %d · 引用 %s · %s%s" % (
            len(source_ids), len(passage_aids),
            "有" if cited else "无",
            "拒答" if refusal else "作答",
            ("  期望 %s → %s" % (",".join(expect), "命中" if hit else "未命中")) if expect else "",
        ))
        results.append({
            "question": question, "expect": expect, "hit": hit,
            "sources": source_ids, "passageAids": passage_aids,
            "cited": cited, "refusal": refusal, "status": status,
            "reply": reply,
        })
        if i < len(questions) and args.delay:
            time.sleep(args.delay)

    print("\n" + "=" * 48)
    print("成功应答：%d / %d" % (n_ok, len(questions)))
    if n_recall_q:
        print("召回率 recall@k：%.0f%%  (%d/%d 已标注题命中期望篇目)" % (
            100.0 * n_recall_hit / n_recall_q, n_recall_hit, n_recall_q))
    else:
        print("召回率：暂无（eval_questions.json 尚无 expectArticles 标注）")
    if n_ok:
        print("引用率：%.0f%%   拒答率：%.0f%%" % (100.0 * n_cite / n_ok, 100.0 * n_refusal / n_ok))
        print("平均出处 %.1f · 平均检索段 %.1f" % (sum_sources / n_ok, sum_passages / n_ok))

    if args.out:
        json.dump({"endpoint": args.endpoint, "results": results}, open(args.out, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        print("\n明细已写入 %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
