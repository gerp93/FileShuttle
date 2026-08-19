"""One-off icon generation from assets/logo.png. Run with:
    python scripts/generate_icons.py
after replacing assets/logo.png with a new source mark.

Unlike the PyInstaller-based reference script this pattern is normally
copied from (see gerp93/KVG_Standards' app-standards skill, citing
KVGrainy's scripts/generate_icons.py), this doesn't hand-generate a
.ico/.icns: Flet's own build pipeline auto-discovers assets/icon.png by
convention (flet_cli's `customize_icons`/`find_platform_image`, looking
for a file literally named "icon" under assets/) and generates every
platform's packaged-binary icon from it — a second, hand-rolled icon.ico
would just be redundant.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "logo.png"
ASSETS = ROOT / "assets"


def main():
    src = Image.open(SRC).convert("RGBA")

    # Pad to a square canvas using a transparent background so a non-square
    # source doesn't get cropped or distorted.
    side = max(src.size)
    squared = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    squared.paste(src, ((side - src.width) // 2, (side - src.height) // 2), src)

    ASSETS.mkdir(exist_ok=True)

    # flet build's flutter_launcher_icons step (Windows/macOS/Linux
    # packaged binary icon) auto-discovers this by name/convention. Also
    # used at runtime for the tray icon (pystray loads it via Pillow).
    icon = squared.resize((512, 512), Image.LANCZOS)
    icon.save(ASSETS / "icon.png")

    # page.window.icon (the runtime window/taskbar icon, Windows only)
    # docs specifically call for a .ico file rather than a .png.
    icon.save(ASSETS / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])

    print("Icons generated.")


if __name__ == "__main__":
    main()
