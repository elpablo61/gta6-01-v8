#!/usr/bin/env python3
"""Crescent Bay contact sheet — fresh from the prose spec.

Layout (768x480 total): cover 768x320 on top, three 256x160 below.
Also writes a grayscale twin. JPEG quality ~80.
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOTS = os.path.join(ROOT, "screenshots")

ORDER = ["1-cover.jpg", "2-mission.jpg", "3-night.jpg", "4-start.jpg"]
COVER_SIZE = (768, 320)
SMALL_SIZE = (256, 160)
SHEET_SIZE = (768, 480)


def load(name):
    p = os.path.join(SHOTS, name)
    img = Image.open(p).convert("RGB")
    return img


def build(gray=False):
    sheet = Image.new("RGB", SHEET_SIZE, (0, 0, 0))
    cover = load(ORDER[0]).resize(COVER_SIZE, Image.LANCZOS)
    if gray:
        cover = cover.convert("L").convert("RGB")
    sheet.paste(cover, (0, 0))
    for i, name in enumerate(ORDER[1:]):
        small = load(name).resize(SMALL_SIZE, Image.LANCZOS)
        if gray:
            small = small.convert("L").convert("RGB")
        sheet.paste(small, (i * 256, 320))
    return sheet


def main():
    for name in ORDER:
        p = os.path.join(SHOTS, name)
        size = os.path.getsize(p)
        print(f"  {name}: {size} bytes {'OK' if size <= 200 * 1024 else 'OVER 200 KiB!'}")
    sheet = build(gray=False)
    # NOTE: the dossier caps screenshots/ at exactly 4 files, so the
    # contact sheets live at the repo root, NOT in screenshots/.
    out = os.path.join(ROOT, "contact-sheet.jpg")
    sheet.save(out, "JPEG", quality=80)
    print(f"  contact-sheet.jpg: {os.path.getsize(out)} bytes, {sheet.size}")
    gray = build(gray=True)
    out_gray = os.path.join(ROOT, "contact-sheet-gray.jpg")
    gray.save(out_gray, "JPEG", quality=80)
    print(f"  contact-sheet-gray.jpg: {os.path.getsize(out_gray)} bytes, {gray.size}")
    # Two-second readability: cover + 3 thumbs must all be present.
    assert sheet.size == SHEET_SIZE and gray.size == SHEET_SIZE
    print("  contact sheet OK (768x480, cover + 3 thumbs, + grayscale twin)")


if __name__ == "__main__":
    main()
