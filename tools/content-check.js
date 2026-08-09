// 内容层体检：只读 site/data/articles/*.json，产出 fixes/ 下的核对清单与待审修订稿。
// 不改动任何镜像数据——经典原文的改动一律经人工核准后再落盘。
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'site', 'data', 'articles');
const OUT = path.join(__dirname, '..', 'fixes');
fs.mkdirSync(OUT, { recursive: true });

const ids = fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const rows = [];
const misaligned = [];   // 原文与白话被塞进同一字段的篇目

for (const id of ids) {
  const a = JSON.parse(fs.readFileSync(path.join(DATA, id + '.json'), 'utf8'));
  const segs = a.segments || [];
  const orig = segs.reduce((n, s) => n + (s.orig || []).length, 0);
  const trans = segs.reduce((n, s) => n + (s.trans || []).length, 0);

  // 症状：某一段里原文与白话夹在同一字符串内（换行 + 全角缩进是白话另起的标志）
  for (const s of segs) {
    for (const key of ['orig', 'trans']) {
      (s[key] || []).forEach((txt) => { if (/\n　　/.test(txt)) misaligned.push({ id, key, title: a.title }); });
    }
  }

  if (id.startsWith('q600')) continue;             // 答问体，本就无白话对照
  if (trans === 0 || orig === 0 || trans !== orig) {
    rows.push({ id, title: a.title, volume: a.volumeName, orig, trans, diff: trans - orig });
  }
}

const csv = ['篇号,标题,分册,原文段,白话段,差值']
  .concat(rows.map((r) => [r.id, r.title, r.volume, r.orig, r.trans, r.diff]
    .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
  .join('\n');
fs.writeFileSync(path.join(OUT, '文白段数不齐清单.csv'), '﻿' + csv);

console.log(`文白段数不齐（已排除 q600 答问体）：${rows.length} 篇 → fixes/文白段数不齐清单.csv`);
console.log(`  其中白话少于原文（优先核有无漏译）：${rows.filter((r) => r.diff < 0).length} 篇`);
console.log(`  其中白话多于原文（多为拆段）：${rows.filter((r) => r.diff > 0).length} 篇`);
console.log(`原文/白话夹在同一字段：${misaligned.length} 处`);
misaligned.forEach((m) => console.log(`   ${m.id}[${m.key}]「${m.title}」`));

/* ---- 为 sb1-181 生成待审修订稿 ----
   该篇 orig 为空，整篇原文与白话被塞进 trans 的一个字符串里：
   每个空行块恰好两行，第一行文言、第二行白话（首块白话带全角缩进）。据此还原成逐段对照。 */
const target = path.join(DATA, 'sb1-181.json');
if (fs.existsSync(target)) {
  const a = JSON.parse(fs.readFileSync(target, 'utf8'));
  const raw = ((a.segments[0] || {}).trans || [])[0];
  if (raw && (a.segments[0].orig || []).length === 0) {
    const blocks = raw.split(/\n{2,}/).map((b) => b.split('\n').filter((l) => l.trim()));
    const ok = blocks.every((b) => b.length === 2);
    if (ok) {
      const fixed = JSON.parse(JSON.stringify(a));
      fixed.segments = [{
        orig: blocks.map((b) => b[0].trim()),
        trans: blocks.map((b) => b[1].replace(/^[　\s]+/, '').trim()),
        notes: a.segments[0].notes || [],   // 注释挂在 segment 上，重建时必须原样带过来
      }];
      fs.writeFileSync(path.join(OUT, 'sb1-181.修订稿.json'), JSON.stringify(fixed, null, 1));
      const side = blocks.map((b, i) =>
        `【${i + 1}】原文：${b[0].trim()}\n     白话：${b[1].replace(/^[　\s]+/, '').trim()}`).join('\n\n');
      fs.writeFileSync(path.join(OUT, 'sb1-181.对照核校.txt'),
        `《三编·上册》卷一·书一　复陈飞青居士书一\n` +
        `原数据 orig 为空、整篇挤在 trans；下为按空行块还原的 ${blocks.length} 段对照，请逐段核对后再决定是否上线。\n\n${side}\n`);
      console.log(`\n已生成待审修订稿：fixes/sb1-181.修订稿.json（${blocks.length} 段对照）`);
      console.log(`核校用逐段对照：fixes/sb1-181.对照核校.txt`);
    } else {
      console.log('\nsb1-181 分块不规则（存在非两行块），不自动生成修订稿，请人工处理');
    }
  }
}
