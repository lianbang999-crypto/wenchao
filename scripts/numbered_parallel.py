"""Strict parser for source-verified, numbered original/translation collections.

The 上堂法语 DOCX lost most of its bold formatting. Its reliable boundaries are
the 67 consecutive subsection headings, blank lines, and explicit note headers.
Do not apply this format to other articles without verifying their source.
"""
import re

SECTION_RE = re.compile(r'^（([一二三四五六七八九十廿卅〇零]+)）')
NOTE_RE = re.compile(r'^\[(\d+)\]\s*(.+)$', re.S)
NOTE_HEADERS = {'【注释】', '注释', '【注释】：', '注释：'}


def section_number(text):
    match = SECTION_RE.match(text.strip())
    if not match:
        return None
    digits = {c: n for n, c in enumerate('零一二三四五六七八九')}
    digits['〇'] = 0
    value = match.group(1).replace('廿', '二十').replace('卅', '三十')
    if '十' in value:
        tens, ones = value.split('十')
        return (digits[tens] if tens else 1) * 10 + (digits[ones] if ones else 0)
    # The source uses 四一, 五一, 六一 for 41, 51, 61.
    return int(''.join(str(digits[c]) for c in value))


def parse_numbered_parallel(lines, expected_sections):
    """Return lossless intermediate segments, failing on ambiguous source shape."""
    segments, group = [], []
    current = 0
    in_notes = False
    body_started = False
    note_number = 0

    def flush_body():
        nonlocal group, body_started
        if not group:
            return
        if len(group) not in (2, 4):
            raise ValueError(f'第 {current} 则文白块应为 2 或 4 行，实际 {len(group)} 行: {group[0][:40]}')
        half = len(group) // 2
        segments.append({'os': group[:half], 'ts': group[half:], 'section': current})
        group = []
        body_started = True

    for raw in lines:
        text = raw.strip()
        number = section_number(text)
        if number is not None:
            flush_body()
            if current and not body_started:
                raise ValueError(f'第 {current} 则缺少正文')
            if number != current + 1:
                raise ValueError(f'分则编号不连续: 预期 {current + 1}，实际 {number}')
            current, in_notes, body_started = number, False, False
            note_number = 0
            segments.append({'o': text})
        elif not text:
            flush_body()
        elif not current:
            raise ValueError(f'首则标题前出现未识别内容: {text[:40]}')
        elif text in NOTE_HEADERS:
            flush_body()
            in_notes = True
            # Keep this in the intermediate stream for character-for-character
            # source verification; migrate_v2 removes the decorative header.
            segments.append({'t': text})
        elif in_notes:
            match = NOTE_RE.match(text)
            if match:
                note_number = int(match.group(1))
                segments.append({'n': note_number, 'note': match.group(2).strip()})
            elif re.match(r'^【[^】]+】', text):
                # Section 50 names 戒检 / 严明 without printed note numbers;
                # its translation refers to them as 注1 / 注2 in this order.
                note_number += 1
                segments.append({'n': note_number, 'note': text, 'unnumbered': True})
            elif segments and 'n' in segments[-1]:
                segments[-1]['note'] += '\n' + text
            else:
                raise ValueError(f'第 {current} 则注释区缺少编号: {text[:40]}')
        elif not body_started and not group and re.fullmatch(r'（[^）]+）', text):
            # A source subtitle follows section 67's heading on its own line.
            segments.append({'o': text})
        else:
            if NOTE_RE.match(text):
                raise ValueError(f'第 {current} 则注释缺少【注释】边界')
            group.append(text)
    flush_body()
    if current != expected_sections or not body_started:
        raise ValueError(f'分则数量或正文不完整: {current}/{expected_sections}')
    return segments
