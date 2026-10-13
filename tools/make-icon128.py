# Draws the extension icon (blue rounded square, white download arrow) and
# writes icons/icon128.png the way the Chrome Web Store asks: the artwork in
# the middle 96×96, with 16 px of transparent padding. Also writes a 512 px
# full-bleed copy for the store's promo tiles.
#   python3 tools/make-icon128.py
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 16  # drawn at 16× the 128 px grid, then scaled down
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)


def art(px):
    im = Image.new('RGBA', (128 * S, 128 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, 128 * S - 1, 128 * S - 1], radius=24 * S, fill=BLUE)
    d.rectangle([54 * S, 24 * S, 76 * S, 70 * S], fill=WHITE)  # stem
    d.polygon([(33 * S, 64 * S), (95 * S, 64 * S), (64 * S, 95 * S)], fill=WHITE)  # head
    d.rectangle([28 * S, 100 * S, 100 * S, 112 * S], fill=WHITE)  # tray
    return im.resize((px, px), Image.LANCZOS)


icon = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
icon.paste(art(96), (16, 16))
icon.save(ROOT / 'icons' / 'icon128.png')
(ROOT / 'docs' / 'store').mkdir(parents=True, exist_ok=True)
art(512).save(ROOT / 'docs' / 'store' / 'icon-512.png')
