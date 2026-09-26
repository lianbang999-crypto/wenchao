#!/usr/bin/env python3
"""Read-only structural gate for the published corpus; does not judge doctrine."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NUMBERED = re.compile(r'(?:^|\n)（[一二三四五六七八九十廿卅〇零]+）(?:\n|$)')


def check_articles():
    errors = []
    paths = sorted((ROOT / 'site/data/articles').glob('*.json'))
    for path in paths:
        article = json.loads(path.read_text())
        if article.get('id') != path.stem:
            errors.append(f'{path.stem}: 篇号不一致')
        for i, seg in enumerate(article.get('segments', [])):
            for note in seg.get('notes', []):
                text = note.get('text', '')
                if NUMBERED.search(text):
                    errors.append(f'{path.stem} 第{i + 1}段: 注释包含独立分则标题，须对照底本')
                if len(text) > 4000:
                    errors.append(f'{path.stem} 第{i + 1}段: 注释超过4000字，须对照底本')
    target = json.loads((ROOT / 'site/data/articles/sbu-145.json').read_text())
    from numbered_parallel import section_number
    headings = [section_number(p) for s in target['segments'] for p in s['orig'] if section_number(p) is not None]
    if headings != list(range(1, 68)):
        errors.append('sbu-145: 底本67则正文标题缺失或顺序错误')
    if target.get('noteScope') != 'segment':
        errors.append('sbu-145: 注释未按分则隔离')
    body = ''.join(p for s in target['segments'] for p in s['orig'])
    if '大觉世尊，示生世间。广张教网，度脱众生。' not in body:
        errors.append('sbu-145: 第二则原文未在原文字段中')
    print(f'结构检查 {len(paths)} 篇；异常 {len(errors)} 项')
    for error in errors:
        print(error)
    return errors


if __name__ == '__main__':
    raise SystemExit(bool(check_articles()))
