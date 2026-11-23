#!/usr/bin/env python3
"""Crescent Bay — contact-sheet builder (fresh, written from the prose spec).

What this does:
  python3 tools/contact-sheet.py              build both sheets from
                                              screenshots/ into the repo root
  python3 tools/contact-sheet.py --dry-run    print the plan, write nothing
  python3 tools/contact-sheet.py --check      verify the existing sheets
                                              without rebuilding them

The judge sees the game mostly through ONE contact sheet, so this script
composes the four screenshots exactly the way the judge sees them
(brief A4, prose spec section 5):

  * cover 768x320 on top (1-cover.jpg, bright daytime waterfront chase)
  * three shots 256x160 in a row below (2-mission, 3-night, 4-start)
  * total canvas 768x480, JPEG quality ~80
  * plus a grayscale twin with the identical layout, so a human can
    check that the player, the police, the road and the HUD still read
    when all colour is gone (brief A7: find the player in 1 second,
    even in grayscale).

The two-second readability test is a HUMAN test — the script cannot look
at the picture for you — but it does run the automated part of it:
every cell must exist, must not be blank, must not be a black box
(the night shot is the usual suspect), and must carry enough luminance
contrast to be distinguishable at a glance. The script prints a PASS /
WARN / FAIL line per cell and refuses to exit 0 when a cell fails, so a
bad sheet is loud instead of silent. After the script runs, LOOK at
both JPEGs at 768x480 and confirm a stranger could answer in 2 seconds:
this is a city, that is the player car, those are police chasing it,
there is a mission, there is a minimap.

Inputs and outputs:
  * Inputs come from --shots (default <repo>/screenshots), named by
    shots.json: 1-cover.jpg, 2-mission.jpg, 3-night.jpg, 4-start.jpg.
    Each input should already be at most 200 KiB (the screenshot driver
    enforces that); this script warns but does not re-encode inputs.
  * Outputs go to --out (default the repo root, OUTSIDE screenshots/,
    per brief A4): contact-sheet.jpg and contact-sheet-gray.jpg.
  * Every run writes a JSON result file under /tmp (never in the repo)
    and prints a human summary to stdout.

Resizing rules (the screenshots are 1280x800, aspect 1.6):
  * The three small cells are exactly 256x160 — the same aspect as the
    source, so they are a plain high-quality (LANCZOS) resize.
  * The cover cell is 768x320 (aspect 2.4), wider than the source, so
    it is scaled to cover the cell and centre-cropped. The crop keeps
    the vertical middle of the frame, where the chase and the HUD live;
    nothing is stretched, so nothing looks squashed at judge size.
  * The grayscale twin is made from the finished colour sheet, not by
    re-laying out the cells, so the two sheets are pixel-identical in
    layout by construction.

Size guard: if a sheet comes out over --max-kib (default 200 KiB) the
script steps the JPEG quality down (80, 70, 60, 50, 40) until it fits.
A sheet that still does not fit at the lowest quality is written at
that quality and reported FAILED.

Exit code: 0 when both sheets are written and every cell check passes
(a WARN still passes but is listed by name); 1 on any failure.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

from PIL import Image

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SHOTS_DIR = os.path.join(REPO_ROOT, "screenshots")
DEFAULT_OUT_DIR = REPO_ROOT

SHEET_WIDTH = 768
SHEET_HEIGHT = 480
COVER_WIDTH = 768
COVER_HEIGHT = 320
CELL_WIDTH = 256
CELL_HEIGHT = 160

# (shot id, file name, cell) — the order is the order on the sheet.
CELLS = [
    ("cover", "1-cover.jpg", (0, 0, COVER_WIDTH, COVER_HEIGHT)),
    ("mission", "2-mission.jpg", (0, COVER_HEIGHT, CELL_WIDTH, COVER_HEIGHT + CELL_HEIGHT)),
    ("night", "3-night.jpg", (CELL_WIDTH, COVER_HEIGHT, 2 * CELL_WIDTH, COVER_HEIGHT + CELL_HEIGHT)),
    ("start", "4-start.jpg", (2 * CELL_WIDTH, COVER_HEIGHT, SHEET_WIDTH, COVER_HEIGHT + CELL_HEIGHT)),
]

DEFAULT_QUALITY = 80
QUALITY_LADDER = [80, 70, 60, 50, 40]
DEFAULT_MAX_KIB = 200

# Automated readability floors, measured on the grayscale version of
# each cell. A cell below either floor is unreadable at a glance:
#   mean luminance: a night shot that reads as a black box sits near 0.
#   luminance stddev: a blank / flat-colour cell sits near 0.
# The night cell is allowed a lower mean (it IS night) but must still
# carry light pools, headlights and a bright HUD, so its floor is only
# a little lower than the others.
MIN_MEAN_LUMINANCE = {"cover": 40.0, "mission": 40.0, "night": 22.0, "start": 40.0}
MIN_STDDEV_LUMINANCE = 12.0
MAX_INPUT_KIB = 200


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")


def load_cell_image(path, box):
    """Open one screenshot and fit it into its cell box (no stretching)."""
    width = box[2] - box[0]
    height = box[3] - box[1]
    img = Image.open(path).convert("RGB")
    if img.size == (width, height):
        return img
    if abs(img.size[0] / img.size[1] - width / height) < 0.01:
        return img.resize((width, height), Image.LANCZOS)
    # Aspect differs (the cover cell is wider than the 1280x800 source):
    # scale to cover the cell, then centre-crop. The vertical middle of
    # the frame holds the chase and the HUD, so the crop keeps it.
    scale = max(width / img.size[0], height / img.size[1])
    grown = img.resize(
        (round(img.size[0] * scale), round(img.size[1] * scale)), Image.LANCZOS
    )
    left = (grown.size[0] - width) // 2
    top = (grown.size[1] - height) // 2
    return grown.crop((left, top, left + width, top + height))


def cell_stats(gray_cell):
    """Mean and standard deviation of luminance over one cell image."""
    pixels = list(gray_cell.getdata())
    n = len(pixels)
    mean = sum(pixels) / n
    variance = sum((p - mean) ** 2 for p in pixels) / n
    return mean, variance ** 0.5


def check_cell(shot_id, gray_cell):
    """Automated half of the two-second readability test for one cell."""
    mean, stddev = cell_stats(gray_cell)
    problems = []
    if mean < MIN_MEAN_LUMINANCE[shot_id]:
        problems.append(
            f"too dark (mean luminance {mean:.1f}, floor {MIN_MEAN_LUMINANCE[shot_id]:.0f})"
        )
    if stddev < MIN_STDDEV_LUMINANCE:
        problems.append(
            f"too flat (luminance stddev {stddev:.1f}, floor {MIN_STDDEV_LUMINANCE:.0f})"
        )
    status = "fail" if problems else "pass"
    detail = (
        f"mean {mean:.1f}, stddev {stddev:.1f}"
        + (f" — {'; '.join(problems)}" if problems else "")
    )
    return status, detail


def save_jpeg(img, path, quality, max_kib):
    """Save at the given quality, stepping down the ladder until it fits."""
    cap_bytes = max_kib * 1024
    used_quality = quality
    for q in [quality] + [x for x in QUALITY_LADDER if x < quality]:
        used_quality = q
        img.save(path, format="JPEG", quality=q, optimize=True)
        if os.path.getsize(path) <= cap_bytes:
            break
    size = os.path.getsize(path)
    return used_quality, size, size <= cap_bytes


def build_sheets(shots_dir, out_dir, quality, max_kib):
    """Compose the colour sheet and its grayscale twin. Returns a report."""
    report = {"cells": [], "sheets": []}
    sheet = Image.new("RGB", (SHEET_WIDTH, SHEET_HEIGHT), (0, 0, 0))
    for shot_id, filename, box in CELLS:
        path = os.path.join(shots_dir, filename)
        if not os.path.isfile(path):
            report["cells"].append(
                {"id": shot_id, "file": filename, "status": "fail", "detail": "missing input file"}
            )
            continue
        size_kib = os.path.getsize(path) / 1024
        cell = load_cell_image(path, box)
        sheet.paste(cell, (box[0], box[1]))
        status, detail = check_cell(shot_id, cell.convert("L"))
        if size_kib > MAX_INPUT_KIB:
            status = "fail" if status == "fail" else "warn"
            detail += f" — input {size_kib:.1f} KiB exceeds the {MAX_INPUT_KIB} KiB cap"
        else:
            detail += f" — input {size_kib:.1f} KiB"
        report["cells"].append(
            {"id": shot_id, "file": filename, "status": status, "detail": detail}
        )
    if any(c["status"] == "fail" for c in report["cells"]):
        return sheet, None, report

    os.makedirs(out_dir, exist_ok=True)
    colour_path = os.path.join(out_dir, "contact-sheet.jpg")
    gray_path = os.path.join(out_dir, "contact-sheet-gray.jpg")
    gray_sheet = sheet.convert("L").convert("RGB")
    for name, img, path in (
        ("colour", sheet, colour_path),
        ("grayscale", gray_sheet, gray_path),
    ):
        used_quality, size, fits = save_jpeg(img, path, quality, max_kib)
        report["sheets"].append(
            {
                "name": name,
                "file": path,
                "bytes": size,
                "kib": round(size / 1024, 1),
                "quality": used_quality,
                "status": "pass" if fits else "fail",
                "detail": (
                    f"{size / 1024:.1f} KiB at quality {used_quality}"
                    + ("" if fits else f" — still over the {max_kib} KiB cap")
                ),
            }
        )
    return sheet, gray_sheet, report


def verify_existing(out_dir, max_kib):
    """Check sheets that are already on disk, without rebuilding them."""
    report = {"cells": [], "sheets": []}
    for name, filename in (
        ("colour", "contact-sheet.jpg"),
        ("grayscale", "contact-sheet-gray.jpg"),
    ):
        path = os.path.join(out_dir, filename)
        if not os.path.isfile(path):
            report["sheets"].append(
                {"name": name, "file": path, "status": "fail", "detail": "file not found"}
            )
            continue
        img = Image.open(path).convert("RGB")
        size = os.path.getsize(path)
        ok = img.size == (SHEET_WIDTH, SHEET_HEIGHT) and size <= max_kib * 1024
        report["sheets"].append(
            {
                "name": name,
                "file": path,
                "bytes": size,
                "kib": round(size / 1024, 1),
                "status": "pass" if ok else "fail",
                "detail": f"{img.size[0]}x{img.size[1]}, {size / 1024:.1f} KiB",
            }
        )
    return report


def new_run(args):
    return {
        "mode": "contact-sheet",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "repo": REPO_ROOT,
        "shotsDir": args.shots,
        "outDir": args.out,
        "quality": args.quality,
        "maxKib": args.max_kib,
        "checks": [],
        "cells": [],
        "sheets": [],
        "outFile": args.out_json or f"/tmp/contact-sheet-{stamp()}.json",
    }


def save_results(run):
    run["finishedAt"] = datetime.now(timezone.utc).isoformat()
    run["summary"] = {
        "total": len(run["checks"]),
        "passed": sum(1 for c in run["checks"] if c["status"] == "pass"),
        "warned": sum(1 for c in run["checks"] if c["status"] == "warn"),
        "failed": sum(1 for c in run["checks"] if c["status"] == "fail"),
    }
    try:
        with open(run["outFile"], "w", encoding="utf-8") as fh:
            json.dump(run, fh, indent=2)
    except OSError:
        try:
            os.makedirs("/tmp", exist_ok=True)
            with open(run["outFile"], "w", encoding="utf-8") as fh:
                json.dump(run, fh, indent=2)
        except OSError:
            pass


def record(run, name, status, detail):
    run["checks"].append({"name": name, "status": status, "detail": detail or ""})
    print(f"  [{status.upper()}] {name}" + (f" — {detail}" if detail else ""))
    save_results(run)


def print_summary(run):
    save_results(run)
    print("")
    print("== CONTACT SHEET SUMMARY ==")
    print(
        f"passed {run['summary']['passed']} / {run['summary']['total']}"
        + (f" ({run['summary']['warned']} warned)" if run["summary"]["warned"] else "")
        + (f", FAILED {run['summary']['failed']}" if run["summary"]["failed"] else "")
    )
    for s in run["sheets"]:
        print(f"  {s['name']}: {s.get('kib', '?')} KiB ({s['status']}) — {s['file']}")
    warned = [c for c in run["checks"] if c["status"] == "warn"]
    if warned:
        print(f"warned (passed, but look closer): {', '.join(c['name'] for c in warned)}")
    print("NOW LOOK at both JPEGs at 768x480 and confirm the two-second test:")
    print("  city, player car, police chase, mission, minimap — all readable?")
    print(f"results: {run['outFile']}")
    return run["summary"]["failed"] == 0


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Compose the 4 screenshots into the 768x480 contact sheet "
        "the judge sees (cover on top, 3 small below) plus a grayscale twin."
    )
    parser.add_argument(
        "--shots",
        default=DEFAULT_SHOTS_DIR,
        help="directory holding 1-cover.jpg .. 4-start.jpg (default: %(default)s)",
    )
    parser.add_argument(
        "--out",
        default=DEFAULT_OUT_DIR,
        help="directory for contact-sheet.jpg + contact-sheet-gray.jpg "
        "(default: repo root, outside screenshots/)",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=DEFAULT_QUALITY,
        help="starting JPEG quality, 1-100 (default: %(default)s; steps down if oversize)",
    )
    parser.add_argument(
        "--max-kib",
        type=int,
        default=DEFAULT_MAX_KIB,
        help="per-sheet size cap in KiB (default: %(default)s)",
    )
    parser.add_argument(
        "--out-json",
        default=None,
        help="JSON result file (default: /tmp/contact-sheet-<ts>.json)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the existing sheets on disk without rebuilding them",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the plan and exit without writing anything",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.quality <= 100:
        parser.error("--quality must be 1-100")
    if args.max_kib <= 0:
        parser.error("--max-kib must be positive")
    return args


def main():
    args = parse_args(sys.argv[1:])
    run = new_run(args)

    if args.dry_run:
        print(f"DRY RUN — inputs from {args.shots}, outputs to {args.out}")
        print(f"  sheet: {SHEET_WIDTH}x{SHEET_HEIGHT}, cover {COVER_WIDTH}x{COVER_HEIGHT} on top,")
        print(f"  three cells {CELL_WIDTH}x{CELL_HEIGHT} below, JPEG quality {args.quality} (floor ladder: {' -> '.join(map(str, QUALITY_LADDER))})")
        for shot_id, filename, box in CELLS:
            print(f"  {shot_id}: {filename} -> cell {box[0]},{box[1]} {box[2]-box[0]}x{box[3]-box[1]}")
        print("dry run ok — no files written")
        return 0

    if args.check:
        report = verify_existing(args.out, args.max_kib)
        run["sheets"] = report["sheets"]
        for s in report["sheets"]:
            record(run, f"sheet-{s['name']}", s["status"], s["detail"])
        return 0 if print_summary(run) else 1

    sheet, gray_sheet, report = build_sheets(args.shots, args.out, args.quality, args.max_kib)
    run["cells"] = report["cells"]
    run["sheets"] = report["sheets"]
    for c in report["cells"]:
        record(run, f"cell-{c['id']}", c["status"], c["detail"])
    for s in report["sheets"]:
        record(run, f"sheet-{s['name']}", s["status"], s["detail"])
    if not report["sheets"]:
        record(
            run,
            "sheets-written",
            "fail",
            "no sheet was written — a cell check failed first; fix the inputs and rerun",
        )
    return 0 if print_summary(run) else 1


if __name__ == "__main__":
    sys.exit(main())
