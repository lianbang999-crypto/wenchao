#!/bin/bash
# 重建知识库索引（Vectorize 向量库 + D1 全文/关键词索引）。
# 从 cursor=0 顺序循环调用 /index，直到 done:true；cursor=0 时 Worker 会 DROP+CREATE 全文表，
# 故务必从头一次跑完，中途断了要从 0 重来。
#
# 用法：
#   INDEX_SECRET=你的密钥 bash scripts/reindex.sh [endpoint] [limit]
# 例：
#   INDEX_SECRET=*** bash scripts/reindex.sh https://wenchao.foyue.org/api/ai
#   INDEX_SECRET=*** bash scripts/reindex.sh https://wenchao.foyue.org/api/ai 5   # 触发 CPU 限制时降批
#   INDEX_SECRET=*** LEX_ONLY=1 bash scripts/reindex.sh                            # 只补建 D1 全文索引，不重嵌入（省额度）
#
# 向量库已就绪、只是站内正文搜索返回空（/health 显示 lexRows:0）时，用 LEX_ONLY=1：
# 它只重建 D1 全文/关键词索引，不调用嵌入接口、不动 Vectorize，零嵌入额度，最省最稳。
#
# INDEX_SECRET 从环境变量读取（不进命令行参数、不入仓库），即 wrangler secret put INDEX_SECRET 的那个值。
set -euo pipefail

ENDPOINT="${1:-${WENCHAO_AI_ENDPOINT:-https://wenchao.foyue.org/api/ai}}"
LIMIT="${2:-}"
: "${INDEX_SECRET:?请先设置环境变量 INDEX_SECRET（Worker 的建库密钥）}"

cursor=0
echo "==> 重建索引：$ENDPOINT"
if [ -n "${LEX_ONLY:-}" ]; then
  echo "    LEX_ONLY=1：只补建 D1 全文/关键词索引，跳过重嵌入（不动 Vectorize、零嵌入额度）"
else
  echo "    从 cursor=0 开始（会 DROP+CREATE D1 全文表 + 重嵌入向量库，消耗嵌入额度），逐批循环到 done…"
fi
while : ; do
  url="$ENDPOINT/index?cursor=$cursor"
  [ -n "$LIMIT" ] && url="$url&limit=$LIMIT"
  [ -n "${LEX_ONLY:-}" ] && url="$url&lexOnly=1"
  resp="$(curl -s -m 120 -X POST "$url" -H "X-Index-Secret: $INDEX_SECRET")"
  # 用 python3 解析这一批的进度（响应只含计数，不含正文，安全）
  fields="$(python3 - "$resp" <<'PY'
import sys, json
try:
    o = json.loads(sys.argv[1])
except Exception:
    print("ERR 0 true 0 0 0 0 false"); sys.exit()
print(o.get("ok", False),
      o.get("cursor", 0), str(o.get("done", True)).lower(),
      o.get("total", 0), o.get("indexedArticles", 0),
      o.get("chunks", 0), o.get("lexIndexed", 0),
      str(o.get("d1", False)).lower())
PY
)"
  read -r ok cursor fin total arts chunks lex d1 <<< "$fields"
  if [ "$ok" != "True" ]; then
    echo "!! 第 cursor 处失败，响应：$resp"
    exit 1
  fi
  echo "   cursor→$cursor / $total   本批：文章 $arts · 向量 $chunks · 全文 $lex · D1=$d1"
  [ "$fin" = "true" ] && break
done
echo "==> 重建完成。自检： curl -s $ENDPOINT/health  （应见 hybridReady:true · lexRows>0 · retrievalVersion:r4）"
