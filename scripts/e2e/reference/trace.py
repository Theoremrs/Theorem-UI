"""The agent-side half of the reference workflow, as an agent would run it in
its workspace: trace the references it gathered with VTracer, measure what the
form needs from them, check each trace against the image it came from, and
write the recipe data an App builds its geometry from.

    cargo install vtracer          # the CLI; VTRACER=<path> if not on PATH
    python -m venv venv && venv/bin/pip install pillow numpy scipy scikit-image
    venv/bin/python scripts/e2e/reference/trace.py <references dir>

(VTracer's Python wheel crashes on import-time argument handling under
Python 3.14 and 3.15 on macOS 27, so this drives the CLI.)

Images listed in REFERENCES are fetched into the references dir from their
`source` when missing. Writes guitar.json and cpu.json next to this file, and overlays of each
trace on its reference to docs/plans/evidence/reference-2026-11-17/.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

HERE = Path(__file__).parent
EVIDENCE = HERE.parents[2] / "docs/plans/evidence/reference-2026-11-17"

REFERENCES = {
    "guitar-front": {
        "file": "front2.jpg",
        "url": "https://commons.wikimedia.org/wiki/File:Guitar_MET_Benedid_1992.1.2_front.jpg",
        "source": "https://upload.wikimedia.org/wikipedia/commons/5/53/Guitar_MET_Benedid_1992.1.2_front.jpg",
        "credit": "Guitar by Joseph Benedid, The Metropolitan Museum of Art 1992.1.2; drawing by D. Wheeldon, 2016",
        "license": "CC0",
        "purpose": "structure and proportion: the outline, sound hole and bracing, drawn to a centimetre scale",
    },
    "cpu-die": {
        "file": "die.jpg",
        "url": "https://commons.wikimedia.org/wiki/File:Die_-_MOS_6502D_-_John_McMaster.jpg",
        "source": "https://upload.wikimedia.org/wikipedia/commons/5/5a/Die_-_MOS_6502D_-_John_McMaster.jpg",
        "credit": "MOS 6502D die, John McMaster",
        "license": "CC BY 4.0",
        "purpose": "structure: where the datapath, control logic and decode ROM sit, and the ring of bonding pads",
    },
    "cpu-package": {
        "file": "pack.jpg",
        "url": "https://commons.wikimedia.org/wiki/File:Pack_top_-_MOS_6502D_-_John_McMaster.jpg",
        "source": "https://upload.wikimedia.org/wikipedia/commons/f/f7/Pack_top_-_MOS_6502D_-_John_McMaster.jpg",
        "credit": "MOS 6502 package, top, John McMaster",
        "license": "CC BY 4.0",
        "purpose": "proportion: the body's length to width and the pins along one side",
    },
}


# -- tracing ------------------------------------------------------------------


def trace(mask: np.ndarray, **options) -> list[np.ndarray]:
    """VTracer's polygons for the filled (True) regions of a mask, in pixels."""
    with tempfile.TemporaryDirectory() as folder:
        source, out = Path(folder) / "mask.png", Path(folder) / "trace.svg"
        Image.fromarray(np.where(mask, 0, 255).astype(np.uint8)).save(source)
        flags = [f"--{name}={value}" for name, value in options.items()]
        subprocess.run(
            [os.environ.get("VTRACER", "vtracer"), "-i", source, "-o", out, "--colormode", "bw", "--mode", "polygon", *flags],
            check=True,
            capture_output=True,
        )
        svg = out.read_text()
    polygons = []
    for tag in re.findall(r"<path [^>]*>", svg):
        shift = re.search(r'translate\(([-\d.]+),([-\d.]+)\)', tag)
        dx, dy = (float(shift.group(1)), float(shift.group(2))) if shift else (0.0, 0.0)
        for sub in re.findall(r"M[^M]+", re.search(r' d="([^"]+)"', tag).group(1)):
            numbers = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", sub)]
            points = np.array(numbers).reshape(-1, 2) + [dx, dy]
            if len(points) >= 3:
                polygons.append(points)
    return polygons


def area(points: np.ndarray) -> float:
    x, y = points[:, 0], points[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def simplify(points: np.ndarray, tolerance: float) -> np.ndarray:
    """Ramer-Douglas-Peucker on a closed outline."""

    def rdp(segment: np.ndarray) -> np.ndarray:
        if len(segment) < 3:
            return segment
        start, end = segment[0], segment[-1]
        line = end - start
        norm = np.hypot(*line) or 1.0
        offsets = segment - start
        distances = np.abs(line[0] * offsets[:, 1] - line[1] * offsets[:, 0]) / norm
        index = int(np.argmax(distances))
        if distances[index] <= tolerance:
            return np.array([start, end])
        return np.vstack([rdp(segment[: index + 1])[:-1], rdp(segment[index:])])

    far = int(np.argmax(np.hypot(*(points - points[0]).T)))
    closed = np.vstack([points, points[:1]])
    return np.vstack([rdp(closed[: far + 1])[:-1], rdp(closed[far:])[:-1]])


def raster(points: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    image = Image.new("1", (shape[1], shape[0]), 0)
    ImageDraw.Draw(image).polygon([tuple(p) for p in points], fill=1)
    return np.array(image, dtype=bool)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum() / (a | b).sum())


def best_trace(mask: np.ndarray, unit: float, tolerances: list[float], floor: float) -> tuple[np.ndarray, list[dict]]:
    """Trace once, then revise: simplify at each tolerance (in `unit`s),
    compare each outline against the mask it came from, and keep the one with
    the fewest points that still overlaps the mask by `floor` (IoU)."""
    polygon = max(trace(mask, filter_speckle=4, corner_threshold=60), key=lambda p: abs(area(p)))
    tried = []
    for tolerance in tolerances:
        outline = simplify(polygon, tolerance * unit)
        score = iou(raster(outline, mask.shape), mask)
        tried.append({"tolerance": tolerance, "points": len(outline), "iou": round(score, 4), "outline": outline})
    good = [t for t in tried if t["iou"] >= floor] or [max(tried, key=lambda t: t["iou"])]
    kept = min(good, key=lambda t: t["points"])
    return kept["outline"], [{k: v for k, v in t.items() if k != "outline"} | {"kept": t is kept} for t in tried]


def dashed_lines(dashes: np.ndarray, unit: float) -> list[tuple[np.ndarray, np.ndarray]]:
    """The straight lines a drawing's dashes make, as (start, end) in pixels:
    probabilistic Hough on the dash pixels, then segments on the same line merged."""
    from skimage.transform import probabilistic_hough_line

    step = 4
    small = dashes[: dashes.shape[0] // step * step, : dashes.shape[1] // step * step]
    small = small.reshape(small.shape[0] // step, step, small.shape[1] // step, step).max(axis=(1, 3))
    segments = probabilistic_hough_line(
        small, threshold=5, line_length=int(1.5 * unit / step), line_gap=int(1.2 * unit / step), rng=1
    )
    lines: list[dict] = []
    for (x0, y0), (x1, y1) in segments:
        a, b = np.array([x0, y0], float) * step, np.array([x1, y1], float) * step
        # One direction per line, whichever way the segment was found.
        angle = float(np.arctan2(b[1] - a[1], b[0] - a[0]) % np.pi)
        for line in lines:
            turn = (angle - line["angle"] + np.pi / 2) % np.pi - np.pi / 2
            if abs(turn) < np.radians(2) and abs(float(line["normal"] @ a) - line["offset"]) < 0.12 * unit:
                along = [float(line["direction"] @ p) for p in (a, b)]
                line["span"] = [min(line["span"][0], *along), max(line["span"][1], *along)]
                break
        else:
            direction = np.array([np.cos(angle), np.sin(angle)])
            normal = np.array([-direction[1], direction[0]])
            lines.append({"angle": angle, "offset": float(normal @ a), "direction": direction, "normal": normal,
                          "span": sorted([float(direction @ a), float(direction @ b)])})
    return [
        (l["direction"] * l["span"][0] + l["normal"] * l["offset"], l["direction"] * l["span"][1] + l["normal"] * l["offset"])
        for l in lines
        if l["span"][1] - l["span"][0] > 2 * unit
    ]


def pair_braces(lines: list[tuple[np.ndarray, np.ndarray]], unit: float) -> list[dict]:
    """A brace is drawn as two parallel dashed lines: pair lines of the same
    angle a brace's width apart into its centreline and width."""
    def key(line):
        a, b = line
        d = (b - a) / np.hypot(*(b - a))
        return np.arctan2(d[1], d[0]) % np.pi, d

    braces, used = [], set()
    for i, first in enumerate(lines):
        if i in used:
            continue
        angle, d = key(first)
        normal = np.array([-d[1], d[0]])
        best = None
        for j, second in enumerate(lines):
            if j <= i or j in used:
                continue
            other, _ = key(second)
            gap = abs(float(normal @ (second[0] - first[0])))
            if min(abs(other - angle), np.pi - abs(other - angle)) < np.radians(5) and 0.25 * unit < gap < 1.5 * unit:
                if best is None or gap < best[1]:
                    best = (j, gap)
        if best is None:
            continue
        j, gap = best
        used |= {i, j}
        second = lines[j]
        # The centreline over the length both lines share.
        along = [float(d @ p) for p in (*first, *second)]
        lo, hi = max(min(along[:2]), min(along[2:])), min(max(along[:2]), max(along[2:]))
        if hi - lo < 3 * unit:
            continue
        middle = (float(normal @ first[0]) + float(normal @ second[0])) / 2
        braces.append({"from": d * lo + normal * middle, "to": d * hi + normal * middle, "width": gap})
    return braces


def fit_circle(points: np.ndarray) -> tuple[float, float, float]:
    """Least-squares circle (Kasa) through outline points."""
    x, y = points[:, 0], points[:, 1]
    a = np.column_stack([x, y, np.ones_like(x)])
    c, d, e = np.linalg.lstsq(a, x**2 + y**2, rcond=None)[0]
    cx, cy = c / 2, d / 2
    return float(cx), float(cy), float(np.sqrt(e + cx**2 + cy**2))


def overlay(image: Image.Image, shapes: list[tuple[str, object]], path: Path, width: int = 900) -> None:
    """The reference with what was traced from it drawn on top, labelled as such."""
    canvas = image.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    scale = canvas.width / width
    for kind, shape in shapes:
        if kind == "polygon":
            draw.line([tuple(p) for p in shape] + [tuple(shape[0])], fill=(220, 40, 40), width=max(2, int(4 * scale)))
        elif kind == "circle":
            cx, cy, r = shape
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(30, 120, 220), width=max(2, int(4 * scale)))
        elif kind == "line":
            draw.line(shape, fill=(30, 150, 80), width=max(2, int(3 * scale)))
    canvas = canvas.resize((width, int(canvas.height / scale)))
    labelled = Image.new("RGB", (width, canvas.height + 24), (255, 255, 255))
    labelled.paste(canvas, (0, 0))
    ImageDraw.Draw(labelled).text(
        (8, canvas.height + 6), "REFERENCE image; coloured lines are the TRACE taken from it", fill=(0, 0, 0)
    )
    labelled.save(path)


# -- the guitar ---------------------------------------------------------------


def brace_kind(start: np.ndarray, end: np.ndarray) -> str:
    """Name a brace by where it runs, in the drawing's centimetres (y from the neck joint)."""
    dx, dy = end - start
    angle = abs(np.degrees(np.arctan2(dy, dx))) % 180
    length = float(np.hypot(dx, dy))
    if (angle < 10 or angle > 170) and length > 12:
        return "transverse bar"
    if max(start[1], end[1]) < 12 and 15 < angle < 165:
        return "X brace"
    if 75 < angle < 105 and max(start[1], end[1]) < 25:
        return "side bar"
    return "strut"


def guitar(references: Path) -> dict:
    meta = REFERENCES["guitar-front"]
    image = Image.open(references / meta["file"])
    gray = np.array(image.convert("L"))
    ink = gray < 128

    # The centimetre scale: the long ticks left of the ruler's thick bar.
    bar = int(np.argmax(ink[:, -400:].sum(0) > ink.shape[0] * 0.5)) + ink.shape[1] - 400
    # How far each row's ink runs left from the bar: a tick's length. Ticks
    # come in a few lengths (millimetre, half-centimetre, centimetre); the
    # longest length that recurs is the centimetre.
    run = np.argmin(ink[:, bar - 1 : bar - 160 : -1], axis=1)
    lengths = np.bincount(run[run > 2])
    recurring = np.where(lengths >= max(10, lengths.max() * 0.05))[0]
    long_ticks = np.where(np.abs(run - recurring.max()) <= 2)[0]
    starts = long_ticks[np.insert(np.diff(long_ticks) > 3, 0, True)]
    gaps = np.diff(starts)
    px_per_cm = float(np.median(gaps[(gaps > np.median(gaps) * 0.6) & (gaps < np.median(gaps) * 1.4)]))

    # The body's outline is the largest ink stroke left of the ruler; its top is
    # open where the neck joins. Close that opening between the two ends nearest
    # the centre, then fill everything the outline encloses.
    labels, _ = ndi.label(ink[:, : bar - 200])
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    frame = {labels[0, 0], labels[30, 30]}
    for index in frame:
        sizes[index] = 0
    stroke = np.zeros_like(ink)
    stroke[:, : bar - 200] = labels == int(np.argmax(sizes))
    ys, xs = np.where(stroke)
    centre = (xs.min() + xs.max()) / 2
    top = ys.min()
    band = stroke[top : top + 60]
    by, bx = np.where(band)
    left_end = (int(bx[bx < centre].max()), int(top + by[bx < centre][np.argmax(bx[bx < centre])]))
    right_end = (int(bx[bx > centre].min()), int(top + by[bx > centre][np.argmin(bx[bx > centre])]))
    closed = Image.fromarray(stroke)
    ImageDraw.Draw(closed).line([left_end, right_end], fill=1, width=6)
    body = ndi.binary_fill_holes(np.array(closed))

    outline_px, attempts = best_trace(body, unit=px_per_cm, tolerances=[0.02, 0.05, 0.1, 0.2, 0.4, 0.8], floor=0.995)

    # The sound hole is the stroke enclosing the largest empty region inside the
    # body: traced, then fitted to the circle it is.
    inner = body & ~ndi.binary_dilation(ink, iterations=3)
    holes, _ = ndi.label(inner)
    hole_sizes = np.bincount(holes.ravel())
    hole_sizes[0] = 0
    # The region under the outline's own fill is the body interior; the hole is
    # the largest region that does not touch the body's boundary.
    edge = ndi.binary_dilation(~body, iterations=6)
    for index in np.unique(holes[edge]):
        hole_sizes[index] = 0
    hole_mask = ndi.binary_fill_holes(holes == int(np.argmax(hole_sizes)))
    hole_polygon = max(trace(hole_mask, filter_speckle=8), key=lambda p: abs(area(p)))
    hole = fit_circle(hole_polygon)

    # Bracing, from the drawing's dashed lines: the dashes are the small ink
    # pieces inside the body (the bridge and the hole's ring are large ones).
    interior = ndi.binary_erosion(body, iterations=12)
    pieces, _ = ndi.label(ink & interior)
    piece_sizes = np.bincount(pieces.ravel())
    dash_ids = np.where((piece_sizes > 20) & (piece_sizes < px_per_cm * px_per_cm * 0.15))[0]
    dashes = np.isin(pieces, dash_ids[dash_ids > 0])
    # The bridge's own small marks (saddle ticks, pins) are not bracing.
    bridge = np.argmax(np.where(np.arange(len(piece_sizes)) > 0, piece_sizes, 0))
    by0, by1 = np.where((pieces == bridge).any(1))[0][[0, -1]]
    bx0, bx1 = np.where((pieces == bridge).any(0))[0][[0, -1]]
    dashes[by0 - 40 : by1 + 40, bx0 - 40 : bx1 + 40] = False
    bridge_box = [bx0, by0, bx1, by1]
    braces = pair_braces(dashed_lines(dashes, px_per_cm), px_per_cm)

    # Everything in centimetres, x across the body, y from the neck joint down.
    origin = np.array([centre, top])

    def cm(points):
        return np.round((np.asarray(points, dtype=float) - origin) / px_per_cm, 2)

    outline_cm = cm(outline_px)
    body_xs = np.where(body.any(0))[0]
    result = {
        "reference": {k: v for k, v in meta.items() if k != "file"},
        "scale": {"px_per_cm": round(px_per_cm, 2), "measured_from": "the drawing's ruler, long (centimetre) ticks"},
        "neck_joint_closed": {"from": left_end, "to": right_end},
        "outline": outline_cm.tolist(),
        "sound_hole": {"center": cm([hole[0], hole[1]]).tolist(), "radius": round(hole[2] / px_per_cm, 2)},
        "braces": [
            {"kind": brace_kind(cm(b["from"]), cm(b["to"])), "from": cm(b["from"]).tolist(), "to": cm(b["to"]).tolist(),
             "width": round(b["width"] / px_per_cm, 2)}
            for b in braces
        ],
        "bridge": cm([bridge_box[:2], bridge_box[2:]]).tolist(),
        "size_cm": {
            "length": round((ys.max() - top) / px_per_cm, 1),
            "width": round((body_xs.max() - body_xs.min()) / px_per_cm, 1),
        },
        "attempts": attempts,
    }
    overlay(
        image,
        [("polygon", outline_px), ("circle", hole)]
        + [("line", [tuple(b["from"]), tuple(b["to"])]) for b in braces]
        + [("polygon", np.array([[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]))],
        EVIDENCE / "trace-guitar.png",
    )
    return result


# -- the 6502 -----------------------------------------------------------------


def cpu(references: Path) -> dict:
    die_meta, pack_meta = REFERENCES["cpu-die"], REFERENCES["cpu-package"]

    # Bonding pads: the dark discs around the die's edge. Threshold the dark,
    # keep blobs of pad size and roundness, trace each, take its centre.
    die = Image.open(references / die_meta["file"])
    gray = np.array(die.convert("L")).astype(float)
    smooth = ndi.gaussian_filter(gray, 1.5)
    dark = smooth < 55
    labels, count = ndi.label(dark)
    h, w = dark.shape
    pads = []
    for index, region in enumerate(ndi.find_objects(labels), start=1):
        blob = labels[region] == index
        size = blob.sum()
        ph, pw = blob.shape
        if not (80 < size < 700) or not (0.6 < ph / pw < 1.6) or size < 0.55 * ph * pw:
            continue
        polygon = max(trace(np.pad(blob, 2), filter_speckle=2), key=lambda p: abs(area(p)))
        cx, cy, r = fit_circle(polygon)
        pads.append([region[1].start + cx - 2, region[0].start + cy - 2, r])
    pads = np.array(pads)

    # Functional blocks, written from the die photo (they are rectangles, so
    # they are measured, not traced): the bit-sliced datapath at left, the
    # control logic in the middle, the decode ROM's regular grid at right.
    blocks_px = {
        "datapath": [70, 80, 345, 545],
        "control": [345, 60, 560, 620],
        "decode": [560, 40, 690, 590],
    }

    package = Image.open(references / pack_meta["file"])
    hsv = np.array(package.convert("HSV")).astype(float) / 255
    pg = np.array(package.convert("L")).astype(float)
    # The body: the dark rectangle. Its rows and columns where most pixels are dark.
    body_dark = ndi.gaussian_filter(pg, 2) < 90
    rows = np.where(body_dark.mean(1) > 0.6)[0]
    cols = np.where(body_dark[rows.min() : rows.max()].mean(0) > 0.6)[0]
    body_box = [int(cols.min()), int(rows.min()), int(cols.max()), int(rows.max())]
    # The pins along the bottom edge: bright metal, unsaturated against the
    # brown body. Below the shoulders the pale wood is unsaturated too, so the
    # band is the shoulders' highlights only, chosen by looking at the photo:
    # the rows just inside the dark region's lower edge, where the shoulders
    # catch the light. Each highlight traces as one pin.
    band = slice(body_box[3] - 36, body_box[3] - 14)
    metal = ndi.binary_opening((hsv[band, :, 1] < 0.3) & (hsv[band, :, 2] > 0.6), iterations=1)
    legs = [p for p in trace(metal, filter_speckle=8) if abs(area(p)) > 100]
    centres = sorted(float(p[:, 0].mean()) for p in legs)
    pitch_px = float(np.median(np.diff(centres))) if len(centres) > 1 else 0.0
    # The body's length runs about a pin pitch past the outer pins' centres;
    # its lower edge is where the shoulders start.
    body_box[0], body_box[2] = int(centres[0] - pitch_px), int(centres[-1] + pitch_px)
    body_box[3] = int(band.start + min(p[:, 1].min() for p in legs))

    # Material: the colours the photo shows, as medians so the painted "2" and
    # the printed lettering do not pull them.
    rgb = np.array(package.convert("RGB")).astype(float)
    body_colour = np.median(rgb[body_box[1] + 20 : body_box[3] - 20, body_box[0] + 300 : body_box[2] - 20].reshape(-1, 3), axis=0)
    pin_colour = np.median(rgb[band][metal].reshape(-1, 3), axis=0)
    die_colour = np.median(np.array(die.convert("RGB")).astype(float).reshape(-1, 3), axis=0)

    def hex_colour(c):
        return "#" + "".join(f"{int(v):02x}" for v in c)

    body_length_px = body_box[2] - body_box[0]
    body_width_px = body_box[3] - body_box[1]
    pins_per_side = len(centres)
    # The pitch of a DIP is 2.54 mm: the traced pitch turns pixels into millimetres.
    mm = 2.54 / pitch_px if pitch_px else 0

    die_box = [float(pads[:, 0].min() - 25), float(pads[:, 1].min() - 25), float(pads[:, 0].max() + 25), float(pads[:, 1].max() + 25)]
    die_size = [die_box[2] - die_box[0], die_box[3] - die_box[1]]

    def unit(x, y):
        return [round((x - die_box[0]) / die_size[0], 4), round((y - die_box[1]) / die_size[1], 4)]

    # Pads in order around the die, counter-clockwise from the top left, as the pins are numbered.
    centre = [(die_box[0] + die_box[2]) / 2, (die_box[1] + die_box[3]) / 2]
    angles = np.arctan2(pads[:, 1] - centre[1], pads[:, 0] - centre[0])
    order = np.argsort(-((angles - np.arctan2(die_box[1] - centre[1], die_box[0] - centre[0])) % (2 * np.pi)))
    result = {
        "references": [{k: v for k, v in m.items() if k != "file"} for m in (die_meta, pack_meta)],
        "die": {
            "aspect": round(die_size[0] / die_size[1], 4),
            "pads": [unit(*pads[i, :2]) + [round(pads[i, 2] / die_size[0], 4)] for i in order],
            "blocks": {
                name: unit(b[0], b[1]) + unit(b[2], b[3]) for name, b in blocks_px.items()
            },
        },
        "package": {
            "pins_per_side": pins_per_side,
            "pitch_mm": 2.54,
            "body_mm": [round(body_length_px * mm, 2), round(body_width_px * mm, 2)],
            "measured_from": "the package photo: pins traced along one side, their pitch taken as 2.54 mm",
            "colours": {"body": hex_colour(body_colour), "pins": hex_colour(pin_colour), "die": hex_colour(die_colour)},
        },
    }
    overlay(
        die,
        [("circle", (x, y, r + 3)) for x, y, r in pads]
        + [("polygon", np.array([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]])) for b in blocks_px.values()],
        EVIDENCE / "trace-cpu-die.png",
        width=740,
    )
    offset = band.start
    overlay(
        package,
        [("polygon", np.array([[body_box[0], body_box[1]], [body_box[2], body_box[1]], [body_box[2], body_box[3]], [body_box[0], body_box[3]]]))]
        + [("polygon", p + [0, offset]) for p in legs],
        EVIDENCE / "trace-cpu-package.png",
    )
    return result


def fetch(references: Path) -> None:
    import urllib.request

    references.mkdir(parents=True, exist_ok=True)
    for meta in REFERENCES.values():
        target = references / meta["file"]
        if not target.exists():
            request = urllib.request.Request(meta["source"], headers={"User-Agent": "theorem-reference-trace/1.0"})
            target.write_bytes(urllib.request.urlopen(request).read())


if __name__ == "__main__":
    references = Path(sys.argv[1])
    fetch(references)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    for name, build in (("guitar", guitar), ("cpu", cpu)):
        data = build(references)
        (HERE / f"{name}.json").write_text(json.dumps(data, indent=1) + "\n")
        print(name, json.dumps({k: v for k, v in data.items() if k not in ("outline",)}, default=str)[:1500])
