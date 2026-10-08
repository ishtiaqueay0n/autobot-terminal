"""Draws the Autobot Terminal icon (build/icon.png, build/icon.ico, resources/icon.png).

Run: python scripts/make-icon.py   (needs Pillow)
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024  # draw large, downsample for smooth edges


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw() -> Image.Image:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # Rounded-square background with a vertical gradient.
    bg = Image.new('RGBA', (S, S))
    top, bottom = (36, 42, 56), (16, 18, 24)
    px = bg.load()
    for y in range(S):
        c = lerp(top, bottom, y / (S - 1)) + (255,)
        for x in range(S):
            px[x, y] = c
    mask = Image.new('L', (S, S), 0)
    pad = 56
    ImageDraw.Draw(mask).rounded_rectangle((pad, pad, S - pad, S - pad), radius=200, fill=255)
    img.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # Subtle inner border.
    d.rounded_rectangle((pad, pad, S - pad, S - pad), radius=200, outline=(70, 80, 100, 255), width=10)

    # Prompt chevron.
    blue = (97, 175, 239, 255)
    w = 92
    p1, p2, p3 = (250, 330), (470, 520), (250, 710)
    d.line([p1, p2, p3], fill=blue, width=w, joint='curve')
    for p in (p1, p3):
        d.ellipse((p[0] - w / 2, p[1] - w / 2, p[0] + w / 2, p[1] + w / 2), fill=blue)

    # Cursor block.
    green = (152, 195, 121, 255)
    d.rounded_rectangle((540, 650, 770, 730), radius=24, fill=green)

    # Assistant spark (four-point star).
    gold = (229, 192, 123, 255)
    cx, cy, r, k = 740, 300, 120, 30
    d.polygon(
        [(cx, cy - r), (cx + k, cy - k), (cx + r, cy), (cx + k, cy + k), (cx, cy + r), (cx - k, cy + k), (cx - r, cy), (cx - k, cy - k)],
        fill=gold,
    )
    return img


def main() -> None:
    big = draw()
    build = ROOT / 'build'
    build.mkdir(exist_ok=True)
    png512 = big.resize((512, 512), Image.LANCZOS)
    png512.save(build / 'icon.png')
    png512.save(ROOT / 'resources' / 'icon.png')
    big.resize((256, 256), Image.LANCZOS).save(
        build / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
    print('wrote build/icon.png, build/icon.ico, resources/icon.png')


if __name__ == '__main__':
    main()
