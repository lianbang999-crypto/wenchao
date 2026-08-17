#!/usr/bin/env python3
"""查看 APP 启动量与安装包下载量（走 Cloudflare 服务端日志，不依赖前端埋点）。

数据来源是 Cloudflare 的 zone 分析：
  · /i/open.gif  —— APP 每次启动打一次，故其请求数 ≈ APP 启动次数
  · /app/*.apk   —— 安装包下载次数（注意：下载不等于安装）

服务端计数的好处是拦截器挡不掉；代价是只有次数、没有设备数。
要看独立设备与地区分布，去 Cloudflare 面板的 Web Analytics（同一批流量的另一视角）。

用法：
  export CLOUDFLARE_API_TOKEN=<有 Zone Analytics:Read 权限的令牌>
  python3 scripts/app_stats.py [天数，默认 7]

令牌在 https://dash.cloudflare.com/profile/api-tokens 建，
权限选「区域 → 分析 → 读取」，区域资源选 foyue.org。
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ZONE_NAME = "foyue.org"
HOST = "wenchao.foyue.org"
API = "https://api.cloudflare.com/client/v4/graphql"


def post(token: str, query: str, variables: dict) -> dict:
  req = urllib.request.Request(
    API,
    data=json.dumps({"query": query, "variables": variables}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
  )
  with urllib.request.urlopen(req, timeout=60) as r:
    out = json.load(r)
  if out.get("errors"):
    raise SystemExit("查询失败：" + json.dumps(out["errors"], ensure_ascii=False, indent=2))
  return out["data"]


def zone_id(token: str) -> str:
  req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/zones?name={ZONE_NAME}",
    headers={"Authorization": f"Bearer {token}"},
  )
  with urllib.request.urlopen(req, timeout=30) as r:
    d = json.load(r)
  if not d.get("success") or not d.get("result"):
    raise SystemExit(f"找不到区域 {ZONE_NAME}，请确认令牌权限含该区域")
  return d["result"][0]["id"]


QUERY = """
query($zone: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: {zoneTag: $zone}) {
      reqs: httpRequestsAdaptiveGroups(
        limit: 200
        filter: {datetime_geq: $since, datetime_leq: $until, clientRequestHTTPHost: $host}
        orderBy: [count_DESC]
      ) { count dimensions { clientRequestPath date } }
    }
  }
}
"""


def main() -> None:
  token = os.environ.get("CLOUDFLARE_API_TOKEN")
  if not token:
    raise SystemExit("请先设置 CLOUDFLARE_API_TOKEN（需 Zone Analytics 读取权限）")
  days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
  until = datetime.now(timezone.utc)
  since = until - timedelta(days=days)

  q = QUERY.replace("$host", f'"{HOST}"').replace(
    "clientRequestHTTPHost: ", "clientRequestHTTPHost: ")
  data = post(token, q, {
    "zone": zone_id(token),
    "since": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "until": until.strftime("%Y-%m-%dT%H:%M:%SZ"),
  })
  rows = data["viewer"]["zones"][0]["reqs"]

  opens = sum(r["count"] for r in rows if r["dimensions"]["clientRequestPath"].startswith("/i/open.gif"))
  apks = [(r["dimensions"]["clientRequestPath"], r["count"])
          for r in rows if r["dimensions"]["clientRequestPath"].endswith(".apk")]

  print(f"\n近 {days} 天（{since:%m-%d} 至 {until:%m-%d}，UTC）\n")
  print(f"  APP 启动次数    {opens}")
  if apks:
    print(f"  安装包下载")
    for path, n in sorted(apks, key=lambda x: -x[1]):
      print(f"    {path.rsplit('/', 1)[-1]:24} {n}")
  else:
    print("  安装包下载      0")
  print("\n  注：启动次数含同一台设备的多次打开；下载次数不等于安装数。")
  print("      独立设备数与地区分布请看 Cloudflare 面板的 Web Analytics。\n")


if __name__ == "__main__":
  main()
