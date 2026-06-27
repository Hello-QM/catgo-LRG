#!/usr/bin/env python3
"""Pad iOS screenshots to exact App Store dimensions (no distortion).

App Store Connect validates screenshots by *exact* pixel size and rejects
anything else. Device captures are often the wrong size (e.g. a 6.1" iPhone or
an 11" iPad). This scales each image to fit the target canvas preserving aspect
ratio, then pads the remainder with the image's own edge colour so the border is
invisible on same-aspect devices and unobtrusive otherwise.

Usage:
    pad_screenshots.py <src_dir> <out_dir> iphone67   # -> 1290x2796
    pad_screenshots.py <src_dir> <out_dir> ipad129    # -> 2048x2732

Targets (portrait):
    iphone67  1290x2796   (iPhone 6.7")      iphone69  1320x2868  (6.9")
    ipad129   2048x2732   (iPad 12.9")       ipad13    2064x2752  (13")

Notes:
    - Drops landscape inputs (App Store wants one orientation; keep portrait).
    - App Store max is 10 screenshots per device — trim the source set yourself.
    - Output is RGB PNG (no alpha; App Store rejects alpha).
"""
import sys, os, glob
from PIL import Image

TARGETS = {
    "iphone67": (1290, 2796), "iphone69": (1320, 2868),
    "ipad129": (2048, 2732), "ipad13": (2064, 2752),
}


def bg_color(im):
    w, h = im.size
    px = im.load()
    s = []
    step = max(1, h // 60)
    for y in range(0, h, step):
        s.append(px[1, y]); s.append(px[w - 2, y])
    s.sort()
    return s[len(s) // 2]


def pad_to(src, dst, TW, TH):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    scale = min(TW / w, TH / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    canvas = Image.new("RGB", (TW, TH), bg_color(im))
    canvas.paste(im.resize((nw, nh), Image.LANCZOS), ((TW - nw) // 2, (TH - nh) // 2))
    canvas.save(dst, "PNG")


def main():
    if len(sys.argv) != 4 or sys.argv[3] not in TARGETS:
        sys.exit(__doc__)
    src_dir, out_dir, target = sys.argv[1:4]
    TW, TH = TARGETS[target]
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    for f in sorted(glob.glob(os.path.join(src_dir, "*"))):
        try:
            w, h = Image.open(f).size
        except Exception:
            continue
        if w > h:
            print(f"skip landscape {os.path.basename(f)}"); continue
        out = os.path.join(out_dir, os.path.splitext(os.path.basename(f))[0] + ".png")
        pad_to(f, out, TW, TH); n += 1
        print(f"{(w, h)} -> {(TW, TH)}  {os.path.basename(out)}")
    print(f"{n} screenshots -> {out_dir}  (App Store max 10/device)")


if __name__ == "__main__":
    main()
