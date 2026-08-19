"""Windows "start on login" toggle, via the current user's Run registry
key — no admin rights needed, no installer/service required. Windows-only:
`is_enabled`/`set_enabled` are no-ops returning False on other platforms,
since FileShuttle's tray/background-run story (see `ui/tray.py`) is
currently Windows-specific too.
"""
import sys
from pathlib import Path

_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_VALUE_NAME = "FileShuttle"

is_supported = sys.platform == "win32"

if is_supported:
    import winreg


def _launch_command() -> str:
    exe = sys.executable
    if getattr(sys, "frozen", False):
        return f'"{exe}" --start-hidden'
    # Running from source: launch via the interpreter + this repo's main.py.
    main_path = Path(__file__).resolve().parents[2] / "main.py"
    return f'"{exe}" "{main_path}" --start-hidden'


def is_enabled() -> bool:
    if not is_supported:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _RUN_KEY) as key:
            winreg.QueryValueEx(key, _VALUE_NAME)
            return True
    except FileNotFoundError:
        return False


def set_enabled(enabled: bool) -> None:
    if not is_supported:
        return
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, _RUN_KEY) as key:
        if enabled:
            winreg.SetValueEx(key, _VALUE_NAME, 0, winreg.REG_SZ, _launch_command())
        else:
            try:
                winreg.DeleteValue(key, _VALUE_NAME)
            except FileNotFoundError:
                pass
