"""System tray icon: lets FileShuttle keep running — and hitting its
schedule — after the window is closed, with a menu to reopen or fully
quit, plus native OS notifications for background events (a completed
scheduled run). Runs via `pystray`'s detached mode, in its own thread
alongside Flet's own event loop.
"""
from pathlib import Path

import pystray
from PIL import Image, ImageDraw, ImageFont

APP_NAME = "FileShuttle"
_ICON_PATH = Path(__file__).resolve().parents[2] / "assets" / "icon.png"


def _build_icon_image() -> Image.Image:
    if _ICON_PATH.exists():
        return Image.open(_ICON_PATH).convert("RGBA")

    # Fallback placeholder, only hit if assets/icon.png hasn't been
    # generated yet (see scripts/generate_icons.py).
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((2, 2, size - 2, size - 2), radius=14, fill=(30, 100, 220, 255))
    font = ImageFont.load_default(size=int(size * 0.55))
    draw.text((size / 2, size / 2), "F", fill=(255, 255, 255, 255), anchor="mm", font=font)
    return img


class TrayManager:
    def __init__(self, on_open, on_quit):
        self._icon = pystray.Icon(
            APP_NAME,
            icon=_build_icon_image(),
            title=APP_NAME,
            menu=pystray.Menu(
                pystray.MenuItem("Open FileShuttle", lambda icon, item: on_open(), default=True),
                pystray.MenuItem("Quit", lambda icon, item: on_quit()),
            ),
        )

    def start(self) -> None:
        self._icon.run_detached()

    def stop(self) -> None:
        self._icon.stop()

    def notify(self, title: str, message: str) -> None:
        if pystray.Icon.HAS_NOTIFICATION:
            self._icon.notify(message, title)
