# Reverie brand guide

How the Reverie banner, wordmark and icon are made, so the look can be reproduced exactly and
sister products (Presence, …) can sit in the same family. Assets live in [`docs/brand/`](brand/);
the README banner is [`images/reverie-banner.png`](../images/reverie-banner.png) (1536 × 1024).

![Reverie banner](../images/reverie-banner.png)

## Colours

| Role | Value | Notes |
|---|---|---|
| KnowAll luminous green | `#22c55e` · rgb(34, 197, 94) | The one brand colour. Subtitle fill, glows, UI accents |
| Neon lettering (wordmark) | ≈ `#d6ffd8` core, `#22c55e` halo | Rendered by the image model; do not recolour, re-tint toward `#22c55e` if a new render drifts teal |
| Backdrop | near-black greens, `#020604` → `#0b1f14` | Dark cinematic scene; no other hue families |
| KnowAll.ai mark | pure white `#ffffff` | Always the white cut of the logo on dark art |

Rule from the banner review: **one colour family**. Ben rejected a version with amber and cyan
nodes as "too many colours"; everything on-brand is green on near-black, with white for the
KnowAll mark only.

## Type

| Element | Face | Source |
|---|---|---|
| **Wordmark** "REVERIE" | Not a font. An outlined neon display lettering designed by gpt-image-1 from the "Logo A" concept and reused as an image | [`brand/reverie-wordmark.png`](brand/reverie-wordmark.png) (RGBA cut-out, 816 × 167) |
| **Subtitle** "GRAPH MEMORY THAT DREAMS" | [Orbitron](https://fonts.google.com/specimen/Orbitron), variable weight axis at **800** (ExtraBold), block capitals | [`brand/fonts/Orbitron.ttf`](brand/fonts/Orbitron.ttf) (SIL OFL 1.1, licence alongside) |
| Body / UI | System sans (portal and README use the platform default) | – |

Michroma and Audiowide were the runners-up for the subtitle; Orbitron was chosen for its squarer,
heavier block caps that echo the wordmark's geometry.

### Setting a new wordmark (sister products)

The wordmark is generated, not typeset. To make a matching one for another product:

1. Run gpt-image-1 with **two reference images**: `docs/brand/reverie-wordmark.png` (or the full
   banner) for the lettering style and the product's own backdrop for the scene. Ask for
   "the same outlined neon-green display lettering, on a dark plate, no other text, no icons".
2. Key the lettering out of its dark plate (subtract the plate colour, fade by luminance) to get
   an RGBA cut-out, then re-tint the RGB toward `#22c55e` keeping luminance if it came out teal.
3. Use the compositing script below with that cut-out; leave stroke weight as generated.

## Layout

All proportions are relative so the same recipe works at any size:

| Element | Rule |
|---|---|
| Wordmark | Centred; width **53 %** of banner width (the natural size at 1536 px); top edge at y = 62 px on a 1024 px-tall banner |
| Subtitle | Exactly the **same width as the wordmark**; height **0.36 ×** wordmark height (squat and bold, stretched with Lanczos); placed **0.60 ×** subtitle height below the wordmark |
| KnowAll.ai mark | White, bottom-right, width **11 %** of banner width, **3 %** margin on both sides |
| Blending | Wordmark and subtitle are **screen-blended** (additive light) so they glow rather than sit on top; subtitle gets a Gaussian glow of radius ≈ height / 6 |

The backdrop is a text-free render (`brand/backdrop-clean.png`): a dark control room, a window
onto stars, a holographic knowledge graph on a pedestal, green monochrome, nothing decorative
(no moons, no mascots, no typed text). The Agents Portal Brain tab was the style reference.

## Reproducing the banner

```bash
pip install pillow
python3 docs/brand/composite-banner.py --out images/reverie-banner.png
# a sister product:
python3 docs/brand/composite-banner.py \
    --wordmark presence-wordmark.png --backdrop presence-backdrop.png \
    --subtitle "THE MEDIA PLANE FOR KNOWALL AGENTS" --out images/presence-banner.png
```

The script encodes every rule in the layout table; the flags let you nudge one at a time.

## Icon

[`images/reverie-icon.png`](../images/reverie-icon.png) is the square mark for package
registries and app lists: the holographic graph motif from the banner without text, on the same
near-black green. Use it at 512 px or larger; there is no monochrome cut yet.

## Assets

| File | What |
|---|---|
| `brand/reverie-wordmark.png` | Wordmark cut-out with alpha (the only source of the lettering) |
| `brand/backdrop-clean.png` | Text-free banner backdrop, 1536 × 1024 |
| `brand/knowall-logo-white.png` | White cut of the KnowAll.ai mark (from `knowall-website/public/images/logo.png`) |
| `brand/fonts/Orbitron.ttf`, `OFL.txt` | Subtitle typeface and its licence |
| `brand/composite-banner.py` | The compositing recipe |

Do not: type the product name in a font over the art, add icons or mascots, introduce a second
colour family, or put the wordmark on a light background.
