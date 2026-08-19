"""Thin app-specific wrapper around kvg_updater's bundle mode (see
gerp93/KVG_Standards). FileShuttle is a Flet app: `flet build` produces a
directory (Flutter engine + embedded Python), not a single executable, so
this uses bundle mode rather than the single-file mode.

check_for_update() is a no-op returning None when not running as a frozen/
packaged build — safe to call unconditionally on every app start.
"""
import sys
from pathlib import Path

from kvg_updater import (
    apply_bundle_update_and_restart as _apply_bundle_update_and_restart,
    check_for_bundle_update as _check_for_bundle_update,
    download_and_extract_bundle as _download_and_extract_bundle,
)

GITHUB_REPO = "gerp93/FileShuttle"
APP_NAME = "FileShuttle"
# The directory the running build lives in — one level above the executable
# found inside it. Unverified against a real `flet build` output layout
# (see gerp93/KVG_Standards' kvg_updater README caveat).
APP_DIR = Path(sys.executable).resolve().parent

try:
    from _version import __version__ as CURRENT_VERSION
except ImportError:
    CURRENT_VERSION = "0.0.0-dev"


def check_for_update() -> dict | None:
    return _check_for_bundle_update(GITHUB_REPO, APP_NAME, CURRENT_VERSION)


def check_and_apply_update(update: dict) -> None:
    """Download and apply `update` (the dict returned by check_for_update()).
    Never returns: exits (Windows) or execv's (macOS/Linux)."""
    staged = _download_and_extract_bundle(update["download_url"], APP_NAME)
    _apply_bundle_update_and_restart(staged, APP_DIR, APP_NAME)
