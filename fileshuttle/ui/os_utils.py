"""Reveal-in-file-manager helper for History's source/destination shortcuts.
Opens the containing folder rather than the file itself, since a moved
file's original path no longer exists once it's been relocated."""
import os
import subprocess
import sys
from pathlib import Path


def open_folder(path: str) -> None:
    folder = Path(path)
    if folder.is_file():
        folder = folder.parent
    if not folder.is_dir():
        return
    if sys.platform == "win32":
        os.startfile(str(folder))
    elif sys.platform == "darwin":
        subprocess.run(["open", str(folder)], check=False)
    else:
        subprocess.run(["xdg-open", str(folder)], check=False)
