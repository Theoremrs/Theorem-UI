"""Set each reference beside what was generated from it, each half labelled.

Run after scripts/e2e/reference.mjs, with the directory trace.py fetched the
references into:

    python scripts/e2e/reference/compare.py <references dir>

Writes compare-*.png beside the e2e's screenshots in
docs/plans/evidence/reference-2026-11-17/.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parents[2] / "docs/plans/evidence/reference-2026-11-17"
HEIGHT = 1000
BAND = 64

PAIRS = [
    ("compare-guitar.png", "front2.jpg", "REFERENCE: measured drawing of the Benedid guitar (D. Wheeldon, CC0)",
     "guitar-4-bracing.png", "RENDER: generated from the outline, hole and bracing traced from it"),
    ("compare-guitar-traced.png", "@frias-front.png", "REFERENCE: the de Frias drawing handed to the App (D. Wheeldon, CC0)",
     "guitar-5-traced-wide.png", "RENDER: the body rebuilt from the outline the App traced"),
    ("compare-cpu-die.png", "die.jpg", "REFERENCE: MOS 6502D die (John McMaster, CC BY 4.0)",
     "cpu-4-die.png", "RENDER: the die level, pads traced from the photo"),
    ("compare-cpu-package.png", "pack.jpg", "REFERENCE: MOS 6502 package (John McMaster, CC BY 4.0)",
     "cpu-1-inline-wide.png", "RENDER: package and pins generated from the measurements"),
]


def half(image: Image.Image, label: str, colour: str) -> Image.Image:
    image = image.convert("RGB")
    image = image.resize((round(image.width * HEIGHT / image.height), HEIGHT), Image.LANCZOS)
    out = Image.new("RGB", (max(image.width, 900), HEIGHT + BAND), "white")
    out.paste(image, ((out.width - image.width) // 2, BAND))
    draw = ImageDraw.Draw(out)
    draw.rectangle([0, 0, out.width, BAND], fill=colour)
    draw.text((16, BAND // 2), label, fill="white", anchor="lm", font=ImageFont.load_default(size=24))
    return out


def main(references: Path) -> None:
    for name, reference, reference_label, render, render_label in PAIRS:
        source = HERE / reference[1:] if reference.startswith("@") else references / reference
        left = half(Image.open(source), reference_label, "#5d574d")
        right = half(Image.open(EVIDENCE / render), render_label, "#a4442c")
        pair = Image.new("RGB", (left.width + right.width + 12, HEIGHT + BAND), "white")
        pair.paste(left, (0, 0))
        pair.paste(right, (left.width + 12, 0))
        pair.save(EVIDENCE / name, optimize=True)
        print(name, pair.size)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
