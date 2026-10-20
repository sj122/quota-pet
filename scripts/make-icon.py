"""生成兜底图标 assets/icon.png 和 assets/icon.ico（一个带仪表弧的圆角方块）。

用法：python scripts/make-icon.py
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")
S = 256


def make():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # 渐变底色
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    top, bottom = (77, 107, 254), (122, 84, 255)
    for y in range(S):
        t = y / (S - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(S):
            px[x, y] = (*c, 255)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((8, 8, S - 8, S - 8), radius=58, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    box = (52, 60, S - 52, S - 44)
    d.arc(box, start=135, end=405, fill=(255, 255, 255, 90), width=22)
    d.arc(box, start=135, end=320, fill=(255, 255, 255, 255), width=22)
    # 两只眼睛
    for cx in (S // 2 - 28, S // 2 + 28):
        d.ellipse((cx - 11, 128 - 11, cx + 11, 128 + 11), fill=(255, 255, 255, 255))
    os.makedirs(OUT, exist_ok=True)
    img.save(os.path.join(OUT, "icon.png"))
    img.save(os.path.join(OUT, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    make()
    print("ok")
