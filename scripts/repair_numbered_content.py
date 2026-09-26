#!/usr/bin/env python3
"""Check source-verified 上堂法语 parsing; --write replaces only its segments.

Requires python-docx. Whitespace is ignored for character reconciliation, as in
the normal parser; no prose is generated or rewritten.
"""
import argparse
import json
import re
from pathlib import Path
import docx
from numbered_parallel import parse_numbered_parallel
from migrate_v2 import convert_segments

ROOT = Path(__file__).resolve().parents[1]


def verified_segments():
    source = next((ROOT / '印祖文钞').glob('07*.docx'))
    paras = docx.Document(source).paragraphs
    start = next(i for i, p in enumerate(paras) if p.style.name == 'Heading 1'
                 and p.text.startswith('上堂法语（居普陀山时代'))
    end = next(i for i in range(start + 1, len(paras)) if paras[i].style.name == 'Heading 1')
    lines = [p.text for p in paras[start + 1:end]]
    parsed = parse_numbered_parallel(lines, 67)
    stream = []
    for g in parsed:
        if 'n' in g:
            stream.append(('' if g.get('unnumbered') else f"[{g['n']}]") + g['note'])
        elif 'os' in g:
            stream.extend(g['os'] + g['ts'])
        else:
            stream.extend(g.get(k, '') for k in ('o', 't'))
    compact = lambda value: re.sub(r'\s+', '', value)
    if compact(''.join(lines)) != compact(''.join(stream)):
        raise ValueError('底本文字对账失败，不允许写入')
    convert_segments.dropped = 0
    return convert_segments(parsed, [], '上堂法语')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    segments = verified_segments()
    path = ROOT / 'site/data/articles/sbu-145.json'
    article = json.loads(path.read_text())
    if args.write:
        article['segments'] = segments
        article['noteScope'] = 'segment'
        article['anomalies'] = ['同篇分则的注释编号独立起算']
        path.write_text(json.dumps(article, ensure_ascii=False) + '\n')
    elif article['segments'] != segments:
        raise SystemExit('当前 JSON 与经底本核验的分段不同')
    print('上堂法语 67 则：底本逐字对账及发布 JSON 分段一致')
