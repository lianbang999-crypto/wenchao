// 镜像自检：把 site/ 里所有 HTML / CSS / JS 的站内引用逐条落到磁盘上核对，
// 再单独核对两处"引用在运行时才拼出来、静态文本里搜不到"的东西：
// 每篇结构化数据 /data/articles/{id}.json，以及 sw.js 的首装清单 SHELL。
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', 'site');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(SITE);
const rel = (f) => path.relative(SITE, f);
const exists = (urlPath) => {
  let p = urlPath.split('?')[0].split('#')[0];
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.join(SITE, decodeURIComponent(p.replace(/^\//, '')));
  if (fs.existsSync(fp)) return fs.statSync(fp).isFile() || fs.existsSync(path.join(fp, 'index.html'));
  return false;
};

const refs = new Map();                       // urlPath -> 首个引用来源
const add = (u, src) => {
  if (!u || /^(https?:|data:|mailto:|javascript:|tel:|#)/.test(u)) return;
  if (!u.startsWith('/')) u = '/' + u;        // 全站 <base href="/">
  u = u.split('?')[0].split('#')[0];
  if (!refs.has(u)) refs.set(u, src);
};

for (const f of all) {
  const ext = path.extname(f);
  if (!['.html', '.css', '.js', '.webmanifest'].includes(ext)) continue;
  const s = fs.readFileSync(f, 'utf8');
  if (ext === '.html') for (const m of s.matchAll(/(?:src|href)=["']([^"']+)["']/g)) add(m[1], rel(f));
  if (ext === '.css' || ext === '.html') for (const m of s.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(m[1], rel(f));
  if (ext === '.js') {
    for (const m of s.matchAll(/["'`](\/[A-Za-z0-9_\-./]+\.(?:json|js|css|svg|png|jpg|jpeg|webp|woff2?|ico|webmanifest|mp3|txt|xml))["'`]/g)) add(m[1], rel(f));
  }
  // webmanifest 里的图标路径是相对根的（"img/icons/…"），按 JSON 取才不会漏
  if (ext === '.webmanifest') {
    try {
      const mf = JSON.parse(s);
      (mf.icons || []).forEach((i) => add(i.src, rel(f)));
      if (mf.start_url) add(mf.start_url, rel(f));
      (mf.shortcuts || []).forEach((sc) => { add(sc.url, rel(f)); (sc.icons || []).forEach((i) => add(i.src, rel(f))); });
      (mf.screenshots || []).forEach((i) => add(i.src, rel(f)));
    } catch { console.log('   webmanifest 解析失败', rel(f)); }
  }
}

const missing = [...refs].filter(([u]) => !exists(u));

// 每篇文章都应有对应的结构化数据
const ids = fs.readdirSync(path.join(SITE, 'a')).filter((d) => !d.startsWith('.'));
const noData = ids.filter((id) => !fs.existsSync(path.join(SITE, 'data', 'articles', id + '.json')));

// Service Worker 首装清单是原子的：少一个文件，整个 SW 装不上，PWA 与离线一起失效
const sw = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');
const shell = (sw.match(/const SHELL = \[([^\]]*)\]/) || [, ''])[1]
  .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
const shellMissing = shell.filter((u) => !exists(u.replace(/^\.\//, '/').replace(/^([^/])/, '/$1')));

// 别再有被当成资源存下来的 SPA 兜底页
const fakeAssets = all.filter((f) => !f.endsWith('.html') && fs.statSync(f).size < 65536 &&
  ['.json', '.ico', '.css', '.js', '.svg', '.webmanifest'].includes(path.extname(f)) &&
  fs.readFileSync(f, 'utf8').slice(0, 200).includes('<!DOCTYPE html>'));

console.log(`站内引用 ${refs.size} 条 → 缺失 ${missing.length} 条`);
missing.forEach(([u, src]) => console.log(`   MISS ${u}   ← ${src}`));
console.log(`文章 ${ids.length} 篇 → 缺结构化数据 ${noData.length} 篇`);
noData.slice(0, 20).forEach((id) => console.log(`   MISS data/articles/${id}.json`));
console.log(`SW 首装清单 ${shell.length} 项 → 缺失 ${shellMissing.length} 项 ${shellMissing.join(' ')}`);
console.log(`被误存为资源的兜底 HTML：${fakeAssets.length} 个 ${fakeAssets.map(rel).join(' ')}`);
const cf = all.filter((f) => f.endsWith('.html'))
  .filter((f) => /cdn-cgi\/content|cloudflareinsights|cf-fonts|__CF\$cv\$params/.test(fs.readFileSync(f, 'utf8')));
console.log(`仍含 Cloudflare 注入的页面：${cf.length} 个`);

const bad = missing.length + noData.length + shellMissing.length + fakeAssets.length + cf.length;
console.log(bad === 0 ? '\n✅ 自检通过：镜像自洽，可直接部署' : `\n❌ 仍有 ${bad} 处问题`);
process.exit(bad === 0 ? 0 : 1);
