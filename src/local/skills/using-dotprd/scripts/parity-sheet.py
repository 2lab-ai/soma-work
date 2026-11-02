#!/usr/bin/env python3
"""parity-sheet: reference-vs-implementation side-by-side receipt composer.

Usage: parity-sheet.py <out.png> <ref.png> <impl.png> [--label-ref TEXT] [--label-impl TEXT]

Any external-product UX-clone loop attaches a sheet built by this script to its
receipt — behavior tests alone do NOT close a visual-parity round (using-dotprd Phase 2).
Scales both captures to equal width, stacks REF on top / IMPL below with labels.
"""
import argparse
from PIL import Image, ImageDraw

def main(argv=None):
    ap = argparse.ArgumentParser(description="Stack a reference capture over an implementation capture.")
    ap.add_argument("out", help="output PNG path")
    ap.add_argument("ref", help="reference capture")
    ap.add_argument("impl", help="implementation capture")
    ap.add_argument("--label-ref", default="REFERENCE", help="label above the reference")
    ap.add_argument("--label-impl", default="IMPLEMENTATION", help="label above the implementation")
    a = ap.parse_args(argv)
    ref, impl = Image.open(a.ref).convert("RGB"), Image.open(a.impl).convert("RGB")
    W = 1800
    def fit(im):
        h = round(im.height * W / im.width)
        return im.resize((W, h), Image.LANCZOS)
    ref, impl = fit(ref), fit(impl)
    BAR = 44
    canvas = Image.new("RGB", (W, ref.height + impl.height + BAR * 2), (10, 10, 14))
    d = ImageDraw.Draw(canvas)
    y = 0
    for label, im in ((a.label_ref, ref), (a.label_impl, impl)):
        d.rectangle([0, y, W, y + BAR], fill=(24, 24, 32))
        d.text((16, y + 12), label, fill=(240, 200, 80))
        y += BAR
        canvas.paste(im, (0, y))
        y += im.height
    canvas.save(a.out)
    print(f"parity sheet: {a.out} ({canvas.width}x{canvas.height})")

if __name__ == "__main__":
    main()
