import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../site/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function addRefs(');
const end = source.indexOf('\n/* 条目出处行', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

test('repeated footnote numbers link to the note in their own subsection', () => {
  const first = [{ n: 1, key: '1-0' }], second = [{ n: 1, key: '3-0' }];
  assert.match(context.addRefs('文字[1]', first), /data-note="1-0"/);
  assert.match(context.addRefs('文字[1]', second), /data-note="3-0"/);
  assert.equal(context.addRefs('文字[2]', second), '文字[2]');
  assert.equal(context.addRefs('文字[1]', []), '文字[1]');
});
