"""Draw the Crosstalk Hub tray icons from the logo's two speech bubbles (web/scripts/make-icons.py).

Usage: python3 native/hub-tray/scripts/tray-icons.py
Writes src-tauri/icons/tray/:
  mac-{on,busy,off,problem}.png    36 px template glyphs (black and alpha; macOS draws them 18 pt tall, light or dark)
  linux-{on,busy,off,problem}.png  64 px colour icons for AppIndicator trays
on: running · busy: starting · off: stopped or not installed · problem: needs a look
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons" / "tray"
OUT.mkdir(parents=True, exist_ok=True)
K = 8  # drawn this many times larger, then scaled down smooth


def shapes(d, P, u, fill_front, fill_back, outline=None, width=0):
    """The logo's bubbles on its 64-unit grid: front 14..44 x 14..36, back 29..50 x 28..46, each with a tail."""
    kw = dict(outline=outline, width=width) if outline else {}
    d.rounded_rectangle([P(29, 28), P(50, 46)], radius=6 * u, fill=fill_back, **kw)
    d.polygon([P(44, 43), P(50, 43), P(50, 51)], fill=fill_back or outline)
    d.rounded_rectangle([P(14, 14), P(44, 36)], radius=8 * u, fill=fill_front, **kw)
    d.polygon([P(20, 33), P(27, 36), P(20, 42)], fill=fill_front or outline)


def glyph(kind: str) -> Image.Image:
    """A template image: only alpha counts. The bubbles span 14..51 on the logo's grid; a 44-unit frame around them
    leaves the margin menu bar glyphs have (about 15 of the 18 points macOS draws)."""
    size = 36 * K
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size / 44
    P = lambda x, y: ((x - 10) * u, (y - 10.5) * u)
    black = (0, 0, 0, 255)
    if kind in ("on", "busy"):
        alpha = 255 if kind == "on" else 120
        # The back bubble stays readable behind the front one: a gap is cut around the front bubble.
        shapes(d, P, u, None, (0, 0, 0, alpha))
        gap = Image.new("L", (size, size), 0)
        gd = ImageDraw.Draw(gap)
        gd.rounded_rectangle([P(12.5, 12.5), P(45.5, 37.5)], radius=9.5 * u, fill=255)
        gd.polygon([P(18.5, 33), P(29, 37), P(18.5, 44)], fill=255)
        cleared = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        img = Image.composite(cleared, img, gap)
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([P(14, 14), P(44, 36)], radius=8 * u, fill=(0, 0, 0, alpha))
        d.polygon([P(20, 33), P(27, 36), P(20, 42)], fill=(0, 0, 0, alpha))
    else:
        w = int(2.6 * u)
        d.rounded_rectangle([P(29, 28), P(50, 46)], radius=6 * u, outline=black, width=w)
        d.polygon([P(44, 44), P(50, 44), P(50, 51)], fill=black)
        d.rounded_rectangle([P(14, 14), P(44, 36)], radius=8 * u, fill=(0, 0, 0, 0), outline=black, width=w)
        d.polygon([P(20, 34), P(27, 34), P(20, 42)], fill=black)
        if kind == "problem":
            # A solid dot, like a badge, over the corner of the front bubble.
            cx, cy, r = 47, 17.5, 6.5
            clear = Image.new("L", (size, size), 0)
            ImageDraw.Draw(clear).ellipse([P(cx - r - 2.5, cy - r - 2.5), P(cx + r + 2.5, cy + r + 2.5)], fill=255)
            img = Image.composite(Image.new("RGBA", (size, size), (0, 0, 0, 0)), img, clear)
            ImageDraw.Draw(img).ellipse([P(cx - r, cy - r), P(cx + r, cy + r)], fill=black)
    return img.resize((36, 36), Image.LANCZOS)


def colour(kind: str) -> Image.Image:
    size = 64 * K
    a, b = {"on": ((91, 140, 255), (142, 92, 247)), "busy": ((91, 140, 255), (142, 92, 247)), "off": ((110, 110, 115), (72, 72, 76)), "problem": ((255, 167, 58), (255, 90, 95))}[kind]
    grad = Image.new("RGBA", (size, size))
    px = grad.load()
    for y in range(0, size, K):
        for x in range(0, size, K):
            t = (x + y) / (2 * (size - 1))
            c = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
            for dy in range(K):
                for dx in range(K):
                    px[x + dx, y + dy] = c
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([2 * K, 2 * K, size - 2 * K, size - 2 * K], radius=14 * K, fill=255 if kind != "busy" else 150)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    u = size / 64
    P = lambda x, y: (x * u, y * u)
    shapes(d, P, u, (255, 255, 255, 242), (255, 255, 255, 150))
    return img.resize((64, 64), Image.LANCZOS)


for kind in ("on", "busy", "off", "problem"):
    glyph(kind).save(OUT / f"mac-{kind}.png")
    colour(kind).save(OUT / f"linux-{kind}.png")
print("wrote tray icons to", OUT)
