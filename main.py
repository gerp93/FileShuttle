import sys

import flet as ft

from fileshuttle.ui.app import main

_MUTEX_NAME = "FileShuttle-SingleInstance-Mutex"


def _acquire_single_instance_lock() -> bool:
    """Windows-only: returns False if another FileShuttle instance already
    holds the mutex. Prevents two schedulers running against the same
    database and double-firing scheduled moves — a real risk now that
    "start at Windows login" can launch a copy alongside one the user
    opens manually. The OS releases the mutex automatically on process
    exit, so there's nothing to explicitly release here."""
    if sys.platform != "win32":
        return True
    import ctypes

    ctypes.windll.kernel32.CreateMutexW(None, False, _MUTEX_NAME)
    already_running = ctypes.GetLastError() == 183  # ERROR_ALREADY_EXISTS
    if already_running:
        ctypes.windll.user32.MessageBoxW(
            None, "FileShuttle is already running — check the system tray.",
            "FileShuttle", 0x40,  # MB_ICONINFORMATION
        )
        return False
    return True


if __name__ == "__main__":
    if not _acquire_single_instance_lock():
        sys.exit(0)

    start_hidden = "--start-hidden" in sys.argv
    ft.run(lambda page: main(page, start_hidden=start_hidden))
