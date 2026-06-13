/* ===================================================================
   经文分享卡 —— 水墨淡彩 · 禅意极简
   选段或整篇 → 生成竖式法宝卡（朱印 + 经文 + 落款 + 二维码）。
   二维码本地生成（qrcode.js 暴露的全局 window.qrcode），扫码直达原文；
   全程不向任何服务器上传内容。
   =================================================================== */

const PAPER = '#f7f1e4', PAPER2 = '#efe6d2';
const INK = '#2c2418', INK2 = '#6d5f49', INK3 = '#a3937a';
const CINNABAR = '#b03a26';
const W = 1080, H = 1440;            // 3:4 竖卡

let modal = null, lastUrl = '';

function ensureModal() {
  if (modal) return modal;
  modal = document.createElement('div');
  modal.className = 'share-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="share-backdrop"></div>
    <div class="share-panel">
      <img class="share-img" alt="经文分享卡预览">
      <div class="share-acts">
        <button class="share-btn primary" data-act="share">分享</button>
        <button class="share-btn" data-act="save">保存图片</button>
        <button class="share-btn" data-act="link">复制链接</button>
        <button class="share-btn ghost" data-act="close">关闭</button>
      </div>
      <p class="share-tip">长按图片亦可保存 · 扫码直达原文</p>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.share-backdrop').onclick = close;
  modal.addEventListener('click', onAct);
  return modal;
}
function close() { if (modal) { modal.hidden = true; modal._blob = null; } }

async function onAct(e) {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  if (act === 'close') return close();
  if (act === 'link') {
    try { await navigator.clipboard.writeText(lastUrl); flash(e.target, '已复制'); }
    catch { flash(e.target, '复制失败'); }
  } else if (act === 'save') {
    download();
  } else if (act === 'share') {
    await doShare();
  }
}
function flash(btn, t) { const o = btn.textContent; btn.textContent = t; setTimeout(() => (btn.textContent = o), 1200); }
function download() {
  const a = document.createElement('a');
  a.href = modal.querySelector('.share-img').src;
  a.download = '文钞分享卡.png'; a.click();
}
async function doShare() {
  const blob = modal._blob;
  const file = blob && new File([blob], '文钞分享卡.png', { type: 'image/png' });
  if (navigator.canShare && file && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text: lastUrl }); return; } catch {}
  }
  download();   // 不支持文件分享时退化为下载
}

/* 对外：打开分享卡。text 为经文（选段或整篇引言），source 为篇名落款，url 为扫码目标 */
export async function openShareCard({ text, source, url }) {
  ensureModal();
  lastUrl = url;
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  drawCard(canvas.getContext('2d'), { text, source, url });
  modal.querySelector('.share-img').src = canvas.toDataURL('image/png');
  canvas.toBlob((b) => { modal._blob = b; }, 'image/png');
  modal.hidden = false;
}

/* ---------------- 绘制 ---------------- */
function drawCard(ctx, { text, source, url }) {
  // 纸底
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, PAPER); g.addColorStop(1, PAPER2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 淡彩：右上一抹朱、左上一抹青
  wash(ctx, W * 0.80, H * 0.12, 380, 'rgba(176,58,38,0.06)');
  wash(ctx, W * 0.16, H * 0.10, 320, 'rgba(58,80,110,0.05)');
  drawMountains(ctx);                       // 底部远山
  // 细外框
  ctx.strokeStyle = 'rgba(44,36,24,0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(46, 46, W - 92, H - 92);

  drawSeal(ctx, W / 2 - 36, 100, 72, '文钞');

  // 经文（按字数分级字号；单行居中，多行左对齐）
  layoutText(ctx, text, { top: 296, bottom: 988 });

  // 朱砂短线
  ctx.fillStyle = CINNABAR;
  ctx.fillRect(W / 2 - 36, 1042, 72, 5);

  // 落款
  ctx.textAlign = 'center';
  ctx.fillStyle = INK2;
  ctx.font = '34px "Kaiti SC","STKaiti","KaiTi",serif';
  ctx.fillText(trim(source || '印光法师文钞', 22), W / 2, 1098);
  ctx.fillStyle = INK3;
  ctx.font = '25px "Kaiti SC","KaiTi",serif';
  ctx.fillText('印光法师文钞 · 文白对照', W / 2, 1140);

  // 二维码
  const qs = 168, qx = W / 2 - qs / 2, qy = 1180;
  drawQR(ctx, url, qx, qy, qs);
  ctx.fillStyle = INK3;
  ctx.font = '24px "Kaiti SC","KaiTi",serif';
  ctx.fillText('扫码读原文', W / 2, qy + qs + 34);
}

const FONT = (fs) => `${fs}px "Noto Serif SC","Songti SC","STSong",serif`;
const LHK = 1.9;                          // 行高系数：经文从容
const X0 = 132, MAXW = W - X0 * 2;        // 文区左右边距
const NO_START = '，。、；：！？）」』,.;:!?)';   // 避头：不可作行首

/* 经文排版：按字数分级字号；一律左对齐 + 首行缩进 + 避头尾 */
function layoutText(ctx, text, { top, bottom }) {
  const n = [...text.trim()].length;
  let fs = n <= 16 ? 58 : n <= 40 ? 50 : n <= 80 ? 44 : 38;
  let lines = wrapLines(ctx, text, fs, true);
  while (fs > 30 && lines.length * fs * LHK > bottom - top) {
    fs -= 2;
    lines = wrapLines(ctx, text, fs, true);
  }
  const lh = fs * LHK;
  const maxLines = Math.max(1, Math.floor((bottom - top) / lh));
  if (lines.length > maxLines) {                            // 极长则截断，余文交给二维码
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '…');
  }
  let y = top + (bottom - top - lines.length * lh) / 2 + fs * 0.82;
  ctx.fillStyle = INK;
  ctx.font = FONT(fs);
  ctx.textAlign = 'left';
  lines.forEach((ln, i) => {
    ctx.fillText(ln, X0 + (i === 0 ? fs * 2 : 0), y);    // 首行缩进 2 字
    y += lh;
  });
  ctx.textAlign = 'center';                                // 复位：落款/二维码居中
}

function wrapLines(ctx, text, fs, indentFirst) {
  ctx.font = FONT(fs);
  const chars = [...text.trim()];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    const avail = (indentFirst && lines.length === 0) ? MAXW - fs * 2 : MAXW;
    if (line && ctx.measureText(line + ch).width > avail) {
      if (NO_START.includes(ch)) { line += ch; }            // 标点回贴本行
      else { lines.push(line); line = ch; }
    } else { line += ch; }
  }
  if (line) lines.push(line);
  return lines;
}
const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function wash(ctx, x, y, r, rgba) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba);
  g.addColorStop(1, rgba.replace(/[\d.]+\)\s*$/, '0)'));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

function drawMountains(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(44,36,24,0.055)';
  ctx.beginPath();
  ctx.moveTo(46, 1210);
  ctx.bezierCurveTo(260, 1090, 430, 1170, 600, 1110);
  ctx.bezierCurveTo(790, 1055, 930, 1150, 1034, 1100);
  ctx.lineTo(1034, 1394); ctx.lineTo(46, 1394); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(44,36,24,0.045)';
  ctx.beginPath();
  ctx.moveTo(46, 1290);
  ctx.bezierCurveTo(300, 1210, 540, 1280, 770, 1230);
  ctx.bezierCurveTo(910, 1200, 985, 1250, 1034, 1220);
  ctx.lineTo(1034, 1394); ctx.lineTo(46, 1394); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawSeal(ctx, x, y, s, chars) {
  ctx.save();
  roundRect(ctx, x, y, s, s, 6); ctx.fillStyle = CINNABAR; ctx.fill();
  ctx.strokeStyle = 'rgba(247,241,228,0.6)'; ctx.lineWidth = 3;
  roundRect(ctx, x + 5, y + 5, s - 10, s - 10, 4); ctx.stroke();
  ctx.fillStyle = '#f7f1e4';
  ctx.font = `bold ${Math.round(s * 0.36)}px "Noto Serif SC","Songti SC",serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const a = [...chars], ch = s * 0.42;
  let cy = y + s / 2 - (a.length - 1) * ch / 2;
  for (const c of a) { ctx.fillText(c, x + s / 2, cy); cy += ch; }
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}

function drawQR(ctx, text, x, y, size) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text); qr.make();
  const n = qr.getModuleCount(), quiet = 4;
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#1a1a1a';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c))
        ctx.fillRect(Math.round(x + (c + quiet) * cell), Math.round(y + (r + quiet) * cell),
          Math.ceil(cell), Math.ceil(cell));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
