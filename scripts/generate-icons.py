#!/usr/bin/env python3
"""Generate app icons as macOS 12-style rounded squares (squircle).

Requires: pip install -r scripts/requirements-icons.txt
  (Pillow)

Outputs:
  build/icon.png, build/icon.icns  — Electron / macOS Dock (icns: macOS only)
  public/favicon-light.png         — light browser chrome (light plate + dark mark)
  public/favicon-dark.png          — dark browser chrome (dark plate + white mark)
  public/apple-touch-icon.png
  public/favicon.ico
"""

from __future__ import annotations

import platform
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit(
        "Missing Pillow. Install with:\n"
        "  pip3 install -r scripts/requirements-icons.txt"
    )

ROOT = Path(__file__).resolve().parents[1]
LOGO = ROOT / "public" / "logo.png"
BUILD_DIR = ROOT / "build"
PUBLIC_DIR = ROOT / "public"

CANVAS = 1024
# Apple HIG / Big Sur+ app icon continuous corner ≈ 22.37% of plate edge
CORNER_RATIO = 0.2237
# Shrink plate so visual size matches Music / other system icons
PLATE_SCALE = 0.86
BG_DARK = (18, 18, 18, 255)
BG_LIGHT = (245, 245, 245, 255)
GRAY = (120, 120, 120, 255)
MARK_DARK = (18, 18, 18, 255)
# Logo height relative to the rounded plate (not full canvas)
LOGO_HEIGHT_RATIO = 0.75
GRAY_LAYER_SCALE = 1.04

RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS


def tint_logo(logo: Image.Image, color: tuple[int, int, int, int]) -> Image.Image:
    alpha = logo.split()[3]
    tinted = Image.new("RGBA", logo.size, color)
    tinted.putalpha(alpha)
    return tinted


def resize_logo(logo: Image.Image, height: int) -> Image.Image:
    ratio = height / logo.height
    width = max(1, round(logo.width * ratio))
    return logo.resize((width, height), RESAMPLE)


def squircle_mask(size: int) -> Image.Image:
    """Opaque rounded-rect mask matching macOS 12 app-icon corners."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = max(1, round(size * CORNER_RATIO))
    inset = max(0, round(size * 0.002))
    draw.rounded_rectangle(
        (inset, inset, size - 1 - inset, size - 1 - inset),
        radius=radius,
        fill=255,
    )
    return mask


def compose_plate(
    plate_size: int,
    *,
    bg: tuple[int, int, int, int],
    mark: Image.Image,
    with_gray_halo: bool,
) -> Image.Image:
    logo_h = max(1, round(plate_size * LOGO_HEIGHT_RATIO))
    logo = resize_logo(mark, logo_h)

    plate = Image.new("RGBA", (plate_size, plate_size), bg)
    content = Image.new("RGBA", (plate_size, plate_size), (0, 0, 0, 0))
    if with_gray_halo:
        gray = resize_logo(tint_logo(mark, GRAY), round(logo_h * GRAY_LAYER_SCALE))
        content.paste(gray, ((plate_size - gray.width) // 2, (plate_size - gray.height) // 2), gray)
    content.paste(logo, ((plate_size - logo.width) // 2, (plate_size - logo.height) // 2), logo)
    plate = Image.alpha_composite(plate, content)

    out = Image.new("RGBA", (plate_size, plate_size), (0, 0, 0, 0))
    out.paste(plate, (0, 0), squircle_mask(plate_size))
    return out


def compose(
    size: int,
    *,
    bg: tuple[int, int, int, int] = BG_DARK,
    mark: Image.Image | None = None,
    with_gray_halo: bool = True,
) -> Image.Image:
    source = Image.open(LOGO).convert("RGBA")
    if mark is None:
        mark = source
    plate_size = max(1, round(size * PLATE_SCALE))
    plate = compose_plate(plate_size, bg=bg, mark=mark, with_gray_halo=with_gray_halo)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - plate_size) // 2
    out.paste(plate, (offset, offset), plate)
    return out


def save_png(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


def save_ico(path: Path) -> None:
    """Multi-size ICO from a single master (Pillow downsamples)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    master = compose(256)
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(path, format="ICO", sizes=sizes)


def save_icns(path: Path) -> None:
    if platform.system() != "Darwin":
        print("skip icon.icns (iconutil is macOS-only)", file=sys.stderr)
        return

    iconset = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        iconset_dir = Path(tmp) / "AppIcon.iconset"
        iconset_dir.mkdir()
        for name, size in iconset.items():
            compose(size).save(iconset_dir / name, format="PNG")
        subprocess.run(
            ["iconutil", "-c", "icns", str(iconset_dir), "-o", str(path)],
            check=True,
        )


def main() -> None:
    if not LOGO.exists():
        raise SystemExit(f"Missing logo: {LOGO}")

    source = Image.open(LOGO).convert("RGBA")
    dark_mark = tint_logo(source, MARK_DARK)

    save_png(BUILD_DIR / "icon.png", compose(CANVAS))
    save_icns(BUILD_DIR / "icon.icns")

    # Theme favicons: contrast against browser chrome (DynamicFavicon switches these)
    save_png(
        PUBLIC_DIR / "favicon-light.png",
        compose(512, bg=BG_LIGHT, mark=dark_mark, with_gray_halo=False),
    )
    save_png(
        PUBLIC_DIR / "favicon-dark.png",
        compose(512, bg=BG_DARK, mark=source, with_gray_halo=True),
    )
    save_png(PUBLIC_DIR / "apple-touch-icon.png", compose(CANVAS))
    save_ico(PUBLIC_DIR / "favicon.ico")

    print(f"Generated (plate={PLATE_SCALE:.0%}, logo={LOGO_HEIGHT_RATIO:.0%} of plate):")
    for p in (
        BUILD_DIR / "icon.png",
        BUILD_DIR / "icon.icns",
        PUBLIC_DIR / "favicon-light.png",
        PUBLIC_DIR / "favicon-dark.png",
        PUBLIC_DIR / "apple-touch-icon.png",
        PUBLIC_DIR / "favicon.ico",
    ):
        status = "ok" if p.exists() else "missing"
        print(f"  {p.relative_to(ROOT)} ({status})")


if __name__ == "__main__":
    main()
