"""Applies VisualAssault (https://github.com/gerp93/VisualAssault) color
themes to the FileShuttle Flet UI. See gerp93/KVG_Standards' theming
standard — exactly one theme dependency per repo, pinned to a tag.
"""
import flet as ft
from visual_assault_flet import THEMES

DEFAULT_THEME_ID = "blue_oval"


def theme_exists(theme_id: str) -> bool:
    return theme_id in THEMES


def get_theme_list() -> list[tuple[str, str]]:
    """[(theme_id, display_name), ...] for populating a picker."""
    return [(theme_id, data["name"]) for theme_id, data in THEMES.items()]


def get_theme_background(theme_id: str) -> str:
    return THEMES[theme_id]["background"]


def get_theme(theme_id: str) -> ft.Theme | None:
    """ft.ColorScheme has no "background" field on flet 0.86.x (Material 3
    dropped the background/on_background pair) — callers must also set
    `page.bgcolor = get_theme_background(theme_id)` separately."""
    theme = THEMES.get(theme_id)
    if theme is None:
        return None
    return ft.Theme(
        color_scheme=ft.ColorScheme(
            primary=theme["primary"],
            surface=theme["surface"],
            on_surface=theme["foreground"],
            outline=theme["border"],
            error=theme["accentRed"],
        )
    )


def apply_theme(page: ft.Page, theme_id: str) -> None:
    """Every VisualAssault theme is a dark palette. Flet's *light* theme
    defaults (near-black body text) apply unless theme_mode is forced to
    DARK — and in dark mode Flet reads `page.dark_theme`, not `page.theme`
    — so plain widgets without an explicit color stay legible against our
    dark `page.bgcolor` instead of rendering unreadably dark-on-dark."""
    page.theme_mode = ft.ThemeMode.DARK
    page.dark_theme = get_theme(theme_id)
    page.bgcolor = get_theme_background(theme_id)
