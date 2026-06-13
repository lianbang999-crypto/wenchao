#!/bin/bash
# 全量数据构建管线（顺序固定，可重复运行）
# 用法: bash scripts/build_all.sh
set -e
cd "$(dirname "$0")/.."

echo "==> 1/4 解析白话版底本 (docx → build/)"
for v in 03 04 05 06 07; do python3 scripts/parse_v2.py "$v"; done
python3 scripts/parse_jiayan.py
python3 scripts/parse_jinghua.py

echo "==> 2/4 迁移到站点数据 (build/ → site/data/)"
for v in 00 jy jh 01 02 03 04 05 06 07; do python3 scripts/migrate_v2.py "$v"; done

echo "==> 3/4 构建嘉言录↔文钞双链"
python3 scripts/link_src.py

echo "==> 4/4 构建全文检索语料"
python3 scripts/build_search.py

echo "==> 完成。改数据后记得给 site/sw.js 的 VER 升版号。"
