#!/usr/bin/env python3
"""Compose a Reverie-family banner: wordmark + block-caps subtitle + white KnowAll.ai mark on a backdrop.

    python3 docs/brand/composite-banner.py \
        --wordmark docs/brand/reverie-wordmark.png \
        --backdrop docs/brand/backdrop-clean.png \
        --subtitle "GRAPH MEMORY THAT DREAMS" \
        --out images/reverie-banner.png

Needs Pillow. See docs/BRANDING.adoc for the rules the defaults encode (subtitle width = wordmark
width, subtitle height = 0.36 x wordmark height, gap = 0.60 x subtitle height, logo 11 % of the
banner width with a 3 % margin). Sister products (e.g. PRESENCE) reuse this with their own
wordmark cut-out and backdrop.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
GREEN = (34, 197, 94)  # KnowAll luminous green #22c55e


def screen(base: Image.Image, layer: Image.Image, pos: tuple[int, int]) -> Image.Image:
    """Screen-blend an RGB layer onto the base at pos (additive light, no hard edges)."""
    canvas = Image.new("RGB", base.size, "black")
    canvas.paste(layer, pos)
    return ImageChops.screen(base, canvas)


def subtitle_layer(text: str, width: int, height: int, font_path: Path, weight: int) -> Image.Image:
    """Orbitron block caps, rendered large then stretched to exactly width x height, with a soft glow."""
    font = ImageFont.truetype(str(font_path), 200)
    try:
        font.set_variation_by_axes([weight])
    except Exception:  # static font file
        pass
    box = font.getbbox(text)
    tw, th = box[2] - box[0], box[3] - box[1]
    layer = Image.new("RGB", (tw + 40, th + 40), "black")
    ImageDraw.Draw(layer).text((20 - box[0], 20 - box[1]), text, font=font, fill=GREEN)
    ink = layer.crop((20, 20, 20 + tw, 20 + th)).resize((width, height), Image.LANCZOS)
    padded = Image.new("RGB", (width + 80, height + 80), "black")
    padded.paste(ink, (40, 40))
    return ImageChops.screen(padded, padded.filter(ImageFilter.GaussianBlur(radius=max(4, height // 6))))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wordmark", type=Path, default=HERE / "reverie-wordmark.png", help="RGBA wordmark cut-out")
    ap.add_argument("--backdrop", type=Path, default=HERE / "backdrop-clean.png", help="text-free backdrop")
    ap.add_argument("--subtitle", default="GRAPH MEMORY THAT DREAMS")
    ap.add_argument("--logo", type=Path, default=HERE / "knowall-logo-white.png")
    ap.add_argument("--font", type=Path, default=HERE / "fonts" / "Orbitron.ttf")
    ap.add_argument("--weight", type=int, default=800, help="Orbitron weight axis (800 = ExtraBold)")
    ap.add_argument("--wordmark-width", type=float, default=0.53, help="wordmark width as a fraction of the banner width")
    ap.add_argument("--wordmark-top", type=float, default=62 / 1024, help="wordmark top edge as a fraction of the banner height (62 px at 1024)")
    ap.add_argument("--subtitle-height", type=float, default=0.36, help="subtitle height as a fraction of wordmark height")
    ap.add_argument("--gap", type=float, default=0.60, help="gap below the wordmark as a fraction of subtitle height")
    ap.add_argument("--logo-width", type=float, default=0.11)
    ap.add_argument("--logo-margin", type=float, default=0.03)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    bg = Image.open(args.backdrop).convert("RGB")
    W, H = bg.size
    top = int(H * args.wordmark_top)

    word = Image.open(args.wordmark).convert("RGBA")
    ww = int(W * args.wordmark_width)
    wh = int(word.height * ww / word.width)
    word = word.resize((ww, wh), Image.LANCZOS)
    # premultiply onto black so the screen blend only adds the lettering's own light
    word_rgb = Image.alpha_composite(Image.new("RGBA", word.size, (0, 0, 0, 255)), word).convert("RGB")
    wx = (W - ww) // 2
    out = screen(bg, word_rgb, (wx, top))

    # The rules are relative to the lettering itself (its alpha bounding box), not the padded file.
    core = word.getchannel("A").point(lambda a: 255 if a > 160 else 0)  # the strokes, not their glow halo
    bx0, by0, bx1, by1 = core.getbbox() or (0, 0, ww, wh)
    letters_w, letters_h = bx1 - bx0, by1 - by0
    sub_h = int(letters_h * args.subtitle_height)
    sub = subtitle_layer(args.subtitle, letters_w, sub_h, args.font, args.weight)
    sx = wx + bx0
    sy = top + by1 + int(sub_h * args.gap)
    out = screen(out, sub, (sx - 40, sy - 40)).convert("RGBA")

    logo = Image.open(args.logo).convert("RGBA")
    lw = int(W * args.logo_width)
    lh = int(logo.height * lw / logo.width)
    m = int(W * args.logo_margin)
    out.alpha_composite(logo.resize((lw, lh), Image.LANCZOS), (W - lw - m, H - lh - m))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.convert("RGB").save(args.out)
    print(f"wrote {args.out} ({W}x{H})")


if __name__ == "__main__":
    main()
