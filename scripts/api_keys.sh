#!/bin/bash
# 管理 AI 问答接口的 API key（第三方/服务端调用凭证）。
#
# 模型：维护一份本地「主表」JSON（workers/ai-proxy/.api_keys.json，已 gitignore），
#       用本脚本增删，再 push 成 Worker Secret API_KEYS。
#       Worker Secret 写后不可读回，故本地主表是唯一可读的真相来源——请妥善保管、勿入仓库。
#
# 用法：
#   bash scripts/api_keys.sh new <名称> [每日额度]   # 生成新 key，写入主表并打印明文(仅此一次)
#   bash scripts/api_keys.sh revoke <名称>           # 停用某 key（disabled:true）
#   bash scripts/api_keys.sh rm <名称>               # 从主表彻底删除某 key
#   bash scripts/api_keys.sh list                    # 列出主表中的 key（只显示名称/额度/状态，不显明文）
#   bash scripts/api_keys.sh push                    # 把主表写入 Worker Secret API_KEYS（即时生效）
#
# 调用方拿到明文后这样请求：
#   curl -X POST https://wenchao.foyue.org/api/ai \
#     -H "Authorization: Bearer <明文key>" -H "Content-Type: application/json" \
#     -d '{"messages":[{"role":"user","content":"念佛如何摄心？"}]}'
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$ROOT/workers/ai-proxy/.api_keys.json"
[ -f "$STORE" ] || echo '{}' > "$STORE"

cmd="${1:-}"
case "$cmd" in
  new)
    name="${2:?用法: api_keys.sh new <名称> [每日额度]}"
    limit="${3:-}"
    token="wc_live_$(openssl rand -hex 24)"
    STORE="$STORE" NAME="$name" TOKEN="$token" LIMIT="$limit" python3 - <<'PY'
import os, json
p = os.environ["STORE"]
d = json.load(open(p, encoding="utf-8"))
rec = {"name": os.environ["NAME"]}
lim = os.environ.get("LIMIT", "")
if lim:
    rec["limit"] = int(lim)
d[os.environ["TOKEN"]] = rec
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
    echo "✓ 已生成并写入主表（名称：$name${limit:+，每日额度：$limit}）"
    echo "  明文 key（请复制给调用方，之后无法再查看）："
    echo "    $token"
    echo "  执行 'bash scripts/api_keys.sh push' 后线上生效。"
    ;;
  revoke|rm)
    name="${2:?用法: api_keys.sh $cmd <名称>}"
    STORE="$STORE" NAME="$name" MODE="$cmd" python3 - <<'PY'
import os, json, sys
p = os.environ["STORE"]
d = json.load(open(p, encoding="utf-8"))
hit = [t for t, r in d.items() if r.get("name") == os.environ["NAME"]]
if not hit:
    sys.exit(f"!! 主表中无名称为 {os.environ['NAME']} 的 key")
for t in hit:
    if os.environ["MODE"] == "rm":
        d.pop(t, None)
    else:
        d[t]["disabled"] = True
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"✓ 已{'删除' if os.environ['MODE']=='rm' else '停用'} {len(hit)} 个 key（名称：{os.environ['NAME']}）")
PY
    echo "  执行 'bash scripts/api_keys.sh push' 后线上生效。"
    ;;
  list)
    STORE="$STORE" python3 - <<'PY'
import os, json
d = json.load(open(os.environ["STORE"], encoding="utf-8"))
if not d:
    print("（主表为空）"); raise SystemExit
print(f"共 {len(d)} 个 key：")
for t, r in d.items():
    state = "停用" if r.get("disabled") else "启用"
    lim = r.get("limit", "默认")
    print(f"  · {r.get('name','?'):<16} 额度 {lim}/日   {state}   ****{t[-6:]}")
PY
    ;;
  push)
    [ -s "$STORE" ] || { echo "!! 主表为空，先 new 一个 key"; exit 1; }
    echo "==> 写入 Worker Secret API_KEYS（来自 $STORE）"
    ( cd "$ROOT/workers/ai-proxy" && npx wrangler secret put API_KEYS < "$STORE" )
    echo "✓ 已写入，线上即时生效。自检： curl -s https://wenchao.foyue.org/api/ai/health | grep apiKey"
    ;;
  *)
    sed -n '2,29p' "$0"
    exit 1
    ;;
esac
