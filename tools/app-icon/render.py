#!/usr/bin/env python3
"""Writes the app icon sources (SVG + manifests for `tauri icon`) into a directory.

Usage: python3 tools/app-icon/render.py <out-dir>

The mark is flat and two-colour: an arched speech bubble on a night-coloured tile.
Four variants share it:
  icon.svg          full-bleed square  -> iOS, legacy Android
  icon-desktop.svg  rounded tile with a transparent margin -> macOS / Windows / Linux
  android-fg.svg    mark only, inside the adaptive-icon safe zone
  android-bg.svg    background only
"""
import json
import sys
from pathlib import Path

SIZE = 1024

INK = '#1c1b22'
CREAM = '#f6ecd9'

DEFS = """
  <defs>
    <clipPath id="tile"><rect width="1024" height="1024" rx="228"/></clipPath>
  </defs>"""

BACKGROUND = f"""
  <rect width="1024" height="1024" fill="{INK}"/>"""

# drawn around the canvas centre: the bubble spans x 282..742, y 188..836 with its tail
MARK = f"""
  <g transform="translate(0 -22)" fill="{CREAM}">
    <path d="M282 440a230 230 0 0 1 460 0v250a70 70 0 0 1-70 70H352a70 70 0 0 1-70-70z"/>
    <path d="M330 700l150 58q-58 76-170 100q44-58 34-128z"/>
  </g>"""


def svg(body: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" '
        f'width="{SIZE}" height="{SIZE}">{DEFS}{body}\n</svg>\n'
    )


def scaled(body: str, factor: float) -> str:
    offset = SIZE * (1 - factor) / 2
    return f'\n  <g transform="translate({offset:g} {offset:g}) scale({factor:g})">{body}\n  </g>'


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    mark = MARK
    (out / 'icon.svg').write_text(svg(BACKGROUND + mark))
    tile = f'\n  <g clip-path="url(#tile)">{BACKGROUND}{mark}\n  </g>'
    (out / 'icon-desktop.svg').write_text(svg(scaled(tile, 0.805)))
    (out / 'android-fg.svg').write_text(svg(scaled(MARK, 0.66)))
    (out / 'android-bg.svg').write_text(svg(BACKGROUND))
    (out / 'mobile.json').write_text(
        json.dumps(
            {
                'default': 'icon.svg',
                'bg_color': INK,
                'android_bg': 'android-bg.svg',
                'android_fg': 'android-fg.svg',
                'android_fg_scale': 100,
            },
            indent=2,
        )
        + '\n'
    )


if __name__ == '__main__':
    main()
