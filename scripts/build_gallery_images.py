#!/usr/bin/env python3
"""把题词与法相原图转码为站内 WebP（展示图 + 缩略图），输出到 site/img/。

源图在仓库内但不进站点；本脚本生成的 WebP 才是 /ying/ 影像页实际加载的资源。
展示图长边 1280、缩略图长边 520，质量 80，足够清晰又显著瘦身。
"""

from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SRC_FX = ROOT / "印祖文钞" / "印光法师法相"
SRC_TICI = ROOT / "传印长老题《印光法师文钞》.jpg"
OUT = ROOT / "site" / "img"
OUT_FX = OUT / "fx"

DISPLAY_EDGE = 1280   # 灯箱展示图长边
THUMB_EDGE = 520      # 网格缩略图长边
Q_DISPLAY = 80
Q_THUMB = 78


def save_webp(img: Image.Image, edge: int, quality: int, dest: Path) -> None:
  im = ImageOps.exif_transpose(img).convert("RGB")
  im.thumbnail((edge, edge), Image.LANCZOS)
  dest.parent.mkdir(parents=True, exist_ok=True)
  im.save(dest, "WEBP", quality=quality, method=6)
  print(f"  {dest.relative_to(ROOT)}  {im.width}x{im.height}  {dest.stat().st_size // 1024}KB")


def main() -> None:
  # 题词：展示图 + 原尺寸大图（灯箱）
  print("题词：")
  with Image.open(SRC_TICI) as im:
    save_webp(im, 1100, 82, OUT / "tici.webp")
    save_webp(im, 1874, 85, OUT / "tici-lg.webp")

  # 法相：按文件名排序映射为 01..23
  print("法相：")
  files = sorted(p for p in SRC_FX.glob("微信图片_*.jpg"))
  for i, f in enumerate(files, 1):
    n = f"{i:02d}"
    with Image.open(f) as im:
      save_webp(im, DISPLAY_EDGE, Q_DISPLAY, OUT_FX / f"{n}.webp")
      save_webp(im, THUMB_EDGE, Q_THUMB, OUT_FX / f"{n}-t.webp")
  print(f"完成：题词 2 张 + 法相 {len(files)} 组")


if __name__ == "__main__":
  main()
