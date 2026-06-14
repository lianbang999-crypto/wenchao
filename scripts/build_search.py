#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全文检索语料构建：site/data/articles/*.json → site/data/search.json

结构：[{i:篇id, v:册名, t:篇名, x:全文}]，x = 原文+白话+注释拼接。
前端懒加载后用子串扫描（中文无需分词，indexOf 足够快），
线上经 gzip 传输（Cloudflare Pages 自动压缩）。
"""
import json
import os

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(PROJ, 'site', 'data')


def main():
    books = json.load(open(os.path.join(DATA, 'books.json'), encoding='utf-8'))
    order = []  # 保持目录顺序，便于结果按书序呈现
    for b in books:
        for j in b['juans']:
            for c in j['cats']:
                for it in c['items']:
                    order.append((it['id'], b['name']))

    out = []
    for aid, vol_name in order:
        a = json.load(open(os.path.join(DATA, 'articles', aid + '.json'), encoding='utf-8'))
        parts = []
        for s in a['segments']:
            parts.extend(s['orig'])
            parts.extend(s['trans'])
            if s.get('src'):
                parts.append(s['src'])
            for n in s['notes']:
                parts.append((f"【{n['term']}】" if n['term'] else '') + n['text'])
        for sec in a.get('xuandu', []):       # 《文钞》选读篇目也纳入检索
            parts.extend(it['t'] for it in sec['items'])
        if a.get('summary'):
            parts.insert(0, a['summary'])
        out.append({'i': aid, 'v': vol_name, 't': a['title'], 'x': '\n'.join(parts)})

    path = os.path.join(DATA, 'search.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    size = os.path.getsize(path) / 1e6
    print(f'完成：{len(out)} 篇 → search.json（{size:.1f} MB）')


if __name__ == '__main__':
    main()
