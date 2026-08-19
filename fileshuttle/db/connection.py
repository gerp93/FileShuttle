"""Owns the single sqlite3 connection FileShuttle uses, and the
user-configurable database location (see gerp93/KVG_Standards'
db-location-versioning.md) that backs it.

Doesn't decide when to restart the app after a location change — that's a
UI concern (`ui/views/settings_view.py`), since the right restart mechanism
depends on how the app was launched.
"""
import os
import sqlite3
import sys
from pathlib import Path

from kvg_dblocation import DbLocation

from .schema import init_schema


def _default_data_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home())
        return Path(base) / "FileShuttle"
    return Path.home() / ".fileshuttle"


db_location = DbLocation(data_dir=_default_data_dir(), default_filename="fileshuttle.db")

_conn: sqlite3.Connection | None = None


def get_connection() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        path = db_location.get_effective_db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(path), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        init_schema(_conn)
    return _conn


def close_connection() -> None:
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


def restart_app() -> None:
    """Re-exec the current process. Needed after a DB location change — an
    already-open sqlite3 connection can't be pointed at a new file path.
    Works the same for a `python` invocation or a Flet-built executable,
    since sys.executable is the built binary itself in the latter case."""
    os.execv(sys.executable, [sys.executable] + sys.argv)
