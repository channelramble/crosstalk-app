"""Render the Crosstalk app icon (two overlapping speech bubbles on a blue-violet gradient) to PNGs.

Usage: python3 web/scripts/make-icons.py
Writes web/public/icon-{1024,512,192,180}.png and maskable variants.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / "public"
OUT.mkdir(parents=True, exist_ok=True)
S = 1024


def gradient(size: int) -> Image.Image:
    a, b = (91, 140, 255), (142, 92, 247)
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return img


def bubbles(size: int, scale: float = 1.0) -> Image.Image:
    """White bubbles on transparent, drawn on a 64-unit grid like the SVG logo."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    u = size / 64 * scale
    off = (size - 64 * u) / 2

    def P(x, y):
        return (off + x * u, off + y * u)

    # front bubble: rounded rect 14..44 x 14..36 with tail
    d.rounded_rectangle([P(14, 14), P(44, 36)], radius=8 * u, fill=(255, 255, 255, 242))
    d.polygon([P(20, 33), P(27, 36), P(20, 42)], fill=(255, 255, 255, 242))
    # back bubble
    back = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(back)
    bd.rounded_rectangle([P(29, 28), P(50, 46)], radius=6 * u, fill=(255, 255, 255, 150))
    bd.polygon([P(44, 43), P(50, 43), P(50, 51)], fill=(255, 255, 255, 150))
    return Image.alpha_composite(back, layer)


def icon(size: int, maskable: bool = False) -> Image.Image:
    base = gradient(S).convert("RGBA")
    art = bubbles(S, 0.82 if maskable else 1.0)
    full = Image.alpha_composite(base, art)
    if not maskable:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.2344), fill=255)
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(full, (0, 0), mask)
        full = out
    return full.resize((size, size), Image.LANCZOS)


for n in (1024, 512, 192, 180):
    icon(n).save(OUT / f"icon-{n}.png")
icon(512, maskable=True).save(OUT / "icon-maskable-512.png")
# Full-bleed square for platforms that apply their own mask (iOS, Android adaptive, Tauri source).
sq = Image.alpha_composite(gradient(S).convert("RGBA"), bubbles(S, 0.9))
sq.save(OUT / "icon-square-1024.png")
print("wrote icons to", OUT)

# macOS-style app icon: rounded square with margins and a soft shadow (Big Sur+ template proportions).
mac = Image.new("RGBA", (S, S), (0, 0, 0, 0))
inner = 824
off = (S - inner) // 2
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle([off, off + 14, off + inner, off + inner + 14], radius=int(inner * 0.2237), fill=(0, 0, 0, 90))
shadow = shadow.filter(ImageFilter.GaussianBlur(18))
mac = Image.alpha_composite(mac, shadow)
face = Image.alpha_composite(gradient(S).convert("RGBA"), bubbles(S, 1.0)).resize((inner, inner), Image.LANCZOS)
mask = Image.new("L", (inner, inner), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner - 1, inner - 1], radius=int(inner * 0.2237), fill=255)
mac.paste(face, (off, off), mask)
mac.save(OUT / "icon-macos-1024.png")
print("wrote macOS icon")
