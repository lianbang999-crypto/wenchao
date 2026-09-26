import re
import unittest
from numbered_parallel import parse_numbered_parallel, section_number
from migrate_v2 import convert_segments


class NumberedParallelTests(unittest.TestCase):
    def test_notes_end_at_next_section_without_relying_on_bold(self):
        lines = ['（一）', '原文甲', '白话甲', '', '【注释】', '[1]【词】释义', '',
                 '（二）', '原文乙', '白话乙', '', '【注释】', '[1]【另词】另一义']
        parsed = parse_numbered_parallel(lines, 2)
        convert_segments.dropped = 0
        out = convert_segments(parsed, [], 'fixture')
        self.assertEqual([x for s in out for x in s['orig']], ['（一）', '原文甲', '（二）', '原文乙'])
        self.assertEqual([x for s in out for x in s['trans']], ['白话甲', '白话乙'])
        self.assertEqual([n['text'] for s in out for n in s['notes']], ['释义', '另一义'])

    def test_missing_section_and_ambiguous_pair_fail_closed(self):
        with self.assertRaises(ValueError):
            parse_numbered_parallel(['（一）', '原', '译', '', '（三）', '原', '译'], 3)
        with self.assertRaises(ValueError):
            parse_numbered_parallel(['（一）', '原', '译', '不明行'], 1)

    def test_source_number_variants(self):
        self.assertEqual([section_number(x) for x in ['（十）', '（四一）', '（六十七）']], [10, 41, 67])


if __name__ == '__main__':
    unittest.main()
