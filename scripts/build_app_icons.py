#!/usr/bin/env python3
"""生成 PWA / 安装到主屏所需的全套 PNG 图标。

来源是站点的"文钞"印章图标（site/icon.svg）：红底圆角、米色边框、竖排"文 / 钞"。
本机无 SVG 渲染器（cairosvg / rsvg / magick 均缺），故直接用 PIL 重绘，
以便精确控制 maskable 安全区与 iOS 专用图的留白。

产物：
  site/img/icons/icon-192.png        普通图标（圆角、透明底）
  site/img/icons/icon-512.png
  site/img/icons/maskable-192.png     maskable（满版红底，内容居中安全区内）
  site/img/icons/maskable-512.png
  site/apple-touch-icon.png           iOS 主屏（180、不透明、方形，系统自行切圆角）

改图标后重跑本脚本即可。颜色取自 manifest 的 background/theme color。
"""
import os
from PIL import Image, ImageDraw, ImageFont

BG = (176, 58, 38)    # #b03a26 朱红
FG = (246, 241, 230)  # #f6f1e6 米色
FONT_PATH = "/System/Library/Fonts/Supplemental/Songti.ttc"
CHARS = ["文", "钞"]
SS = 4  # 超采样倍数，先大图渲染再缩小，边缘更干净

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "site", "img", "icons")


def load_font(px):
    # Songti.ttc 内含多个字重，优先粗体(索引1)，失败回退
    for idx in (1, 0):
        try:
            return ImageFont.truetype(FONT_PATH, px, index=idx)
        except Exception:
            continue
    return ImageFont.truetype(FONT_PATH, px)


def draw_chars(d, box, font_ratio):
    """在 box 内竖排居中绘制"文 / 钞"。"""
    x0, y0, x1, y1 = box
    cw, ch = x1 - x0, y1 - y0
    font = load_font(int(cw * font_ratio))
    cxc = x0 + cw / 2
    for char, yc_ratio in zip(CHARS, (0.30, 0.70)):
        yc = y0 + ch * yc_ratio
        bx = d.textbbox((0, 0), char, font=font)
        tw, th = bx[2] - bx[0], bx[3] - bx[1]
        d.text((cxc - tw / 2 - bx[0], yc - th / 2 - bx[1]), char, font=font, fill=FG)


def make_tile(size, rounded=True, opaque=False):
    """普通图标 / iOS 图标：红底（圆角或方形）+ 边框 + 文钞。"""
    s = size * SS
    img = Image.new("RGB" if opaque else "RGBA", (s, s),
                    BG if opaque else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded and not opaque:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.18), fill=BG)
    inset = int(s * 0.07)
    d.rounded_rectangle([inset, inset, s - inset, s - inset],
                        radius=int(s * 0.11), outline=FG, width=max(2, int(s * 0.03)))
    draw_chars(d, (inset, inset, s - inset, s - inset), 0.50)
    return img.resize((size, size), Image.LANCZOS)


def make_maskable(size):
    """maskable：满版红底，边框与文字收进中心安全区(约74%)，被裁成任意形状都不缺角。"""
    s = size * SS
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    inset = int(s * 0.13)
    d.rounded_rectangle([inset, inset, s - inset, s - inset],
                        radius=int(s * 0.06), outline=FG, width=max(2, int(s * 0.018)))
    draw_chars(d, (inset, inset, s - inset, s - inset), 0.46)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    make_tile(192).save(os.path.join(ICON_DIR, "icon-192.png"))
    make_tile(512).save(os.path.join(ICON_DIR, "icon-512.png"))
    make_maskable(192).save(os.path.join(ICON_DIR, "maskable-192.png"))
    make_maskable(512).save(os.path.join(ICON_DIR, "maskable-512.png"))
    make_tile(180, rounded=False, opaque=True).save(
        os.path.join(ROOT, "site", "apple-touch-icon.png"))
    print("图标已生成：site/img/icons/ 与 site/apple-touch-icon.png")


if __name__ == "__main__":
    main()
