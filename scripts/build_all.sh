#!/bin/bash
# 全量数据构建管线（顺序固定，可重复运行）
# 用法: bash scripts/build_all.sh
set -e
cd "$(dirname "$0")/.."

echo "==> 1/5 解析白话版底本 (docx → build/)"
for v in 03 04 05 06 07; do python3 scripts/parse_v2.py "$v"; done
python3 scripts/parse_jiayan.py
# 菁华录(jh)已撤下（与嘉言录内容重叠）；parse_jinghua.py 保留备用

echo "==> 2/5 迁移到站点数据 (build/ → site/data/)"
for v in 00 jy 01 02 03 04 05 06 07; do python3 scripts/migrate_v2.py "$v"; done

echo "==> 3/6 构建嘉言录↔文钞双链"
python3 scripts/link_src.py

echo "==> 4/6 构建《答念佛600问》(文言引文 → 复用本站语料白话，文白对照)"
python3 scripts/build_600.py

echo "==> 5/6 构建全文检索语料"
python3 scripts/build_search.py

echo "==> 6/6 生成文章独立 URL 页面"
python3 scripts/build_article_pages.py

echo "==> 完成。改数据后记得给 site/sw.js 的 VER 升版号。"
