#!/usr/bin/env python3
"""从品牌原图生成全套 APP / PWA 图标。

来源：brand/logo-source.png（莲台火焰宝珠，方图）。
早前是用 PIL 重绘"文钞"印章，2026-08 换为品牌原图后改走本流程。

原图四周留白极大——内容仅占画布约 29% 宽、54% 高，直接缩放会得到一个
"缩在中间的小图标"。故先按实际内容外接框重新构图：

  · 常规图标（purpose=any）：内容占边长 ~76%，四周留呼吸
  · 可遮罩图标（purpose=maskable）：系统会裁成圆/方圆/水滴，安全区仅中心 80%，
    故内容再收到 ~56%，保证任何裁切形状下都不切到莲台
  · 底色统一取原图背景色，与 manifest 的 background_color 同值——开机屏上
    图标与背景浑然一体，看不出图标的方形边界

浏览器标签页的 favicon 仍用 site/icon.svg（印章）：16–32px 下莲台细节会糊成
一团，而印章的"文钞"二字在极小尺寸仍可辨。

重跑：python3 scripts/build_app_icons.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "brand" / "logo-source.png"
SITE = ROOT / "site"
ICONS = SITE / "img" / "icons"
BG = (252, 250, 246)          # #fcfaf6 —— 原图背景，同时用作开机屏底色


def content_box(im, bg, tol=90, step=2):
  """内容外接框：与背景色差超过 tol 的像素范围。"""
  w, h = im.size
  px = im.load()
  xs, ys = [], []
  for y in range(0, h, step):
    for x in range(0, w, step):
      p = px[x, y]
      if abs(p[0] - bg[0]) + abs(p[1] - bg[1]) + abs(p[2] - bg[2]) > tol:
        xs.append(x)
        ys.append(y)
  return min(xs), min(ys), max(xs), max(ys)


def compose(im, box, ratio, size):
  """把内容按占比 ratio 居中放进 size×size 的底色画布。"""
  x0, y0, x1, y1 = box
  cw, ch = x1 - x0, y1 - y0
  side = int(max(cw, ch) / ratio)                 # 目标方形在原图坐标系下的边长
  cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
  left, top = cx - side // 2, cy - side // 2
  canvas = Image.new("RGB", (side, side), BG)
  # 只取与原图的交集再按偏移贴入：PIL 的 crop 越界会填黑，直接贴会在边缘留黑边，
  # 而 maskable 恰好裁得比画布大，那道黑边会被当成内容、误判安全区。
  w, h = im.size
  l, t = max(0, left), max(0, top)
  r, b = min(w, left + side), min(h, top + side)
  canvas.paste(im.crop((l, t, r, b)), (l - left, t - top))
  return canvas.resize((size, size), Image.LANCZOS)


def main():
  im = Image.open(SRC).convert("RGB")
  box = content_box(im, BG)
  print(f"内容外接框: {box}  (原图 {im.size[0]}×{im.size[1]})")
  ICONS.mkdir(parents=True, exist_ok=True)

  jobs = [
    # (输出路径, 内容占比, 边长)
    (ICONS / "icon-192.png", 0.76, 192),
    (ICONS / "icon-512.png", 0.76, 512),
    (ICONS / "maskable-192.png", 0.56, 192),      # 安全区 80%：内容再收，裁圆也不切
    (ICONS / "maskable-512.png", 0.56, 512),
    (SITE / "apple-touch-icon.png", 0.76, 180),   # iOS 不支持透明，恒带底色
    (ROOT / "app-android" / "store_icon.png", 0.76, 512),   # Play 商店列表用
  ]
  for path, ratio, size in jobs:
    path.parent.mkdir(parents=True, exist_ok=True)
    compose(im, box, ratio, size).save(path, "PNG", optimize=True)
    print(f"  {path.relative_to(ROOT)}  {size}×{size}  内容 {int(ratio * 100)}%")

  compose(im, box, 0.76, 1024).save(ROOT / "brand" / "logo-square.png", "PNG", optimize=True)
  print("  brand/logo-square.png  1024×1024  （留档 / 上架素材）")
  print(f"\n底色 #{BG[0]:02x}{BG[1]:02x}{BG[2]:02x} —— 须与 manifest 的 background_color 一致")


if __name__ == "__main__":
  main()
