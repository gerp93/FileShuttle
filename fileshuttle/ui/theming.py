"""Applies VisualAssault (https://github.com/gerp93/VisualAssault) color
themes to the FileShuttle Flet UI. See gerp93/KVG_Standards' theming
standard — exactly one theme dependency per repo, pinned to a tag.

VisualAssault's flet package only ships plain palette data (see its
README's minimal `ft.ColorScheme(primary=..., surface=..., on_surface=...,
outline=..., error=...)` example) — it doesn't ship Material-3 "on_*"
companion colors. Left unset, Flet/Flutter silently falls back to a fixed
generic dark palette for every field we don't specify, which is where the
poor contrast comes from: Material 3's default ElevatedButton paints its
label in `color_scheme.primary` on top of a `color_scheme.surface`
background, and several VisualAssault themes (e.g. "hacker": primary
#001a00 on surface #0b2a0b) pick those two independently, as accent vs.
panel-background tones, not as a designed foreground/background pair —
so the text can land almost invisibly close to the button color. Same
story for `on_surface_variant`/`surface_container_highest`, which
`ft.Colors.ON_SURFACE_VARIANT`/`SURFACE_CONTAINER_HIGHEST` (used for the
badge/chip text and backgrounds around the app) resolve to when unset.

Rather than only patching the one reported button, every color role Flet
actually reads is filled in below, computing readable "on_*" text with
WCAG relative luminance instead of guessing a hex value per theme — that
keeps this correct for all 15 current themes and any future ones without
per-theme tuning.
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


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(max(0, min(255, round(c))) for c in rgb))


def _relative_luminance(hex_color: str) -> float:
    """WCAG relative luminance, 0.0 (black) - 1.0 (white)."""
    def channel(c: int) -> float:
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = _hex_to_rgb(hex_color)
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def _contrast_ratio(hex_a: str, hex_b: str) -> float:
    la, lb = _relative_luminance(hex_a), _relative_luminance(hex_b)
    lighter, darker = max(la, lb), min(la, lb)
    return (lighter + 0.05) / (darker + 0.05)


def _readable_on(hex_color: str) -> str:
    """Black or white, whichever contrasts more against `hex_color` — used
    for "on_*" roles VisualAssault doesn't provide a designed pair for.
    Picks by actually comparing both contrast ratios rather than a
    luminance-vs-0.5 cutoff: the WCAG contrast formula's black/white
    crossover sits at relative luminance ~0.179, not 0.5, so a naive 0.5
    cutoff picks the *worse* option for a wide range of colors (e.g. hot
    pink #ff69b4, luminance 0.35, contrasts 7.9:1 against black but only
    2.6:1 against white)."""
    if _contrast_ratio(hex_color, "#000000") >= _contrast_ratio(hex_color, "#ffffff"):
        return "#000000"
    return "#ffffff"


def _best_readable(preferred_fg_hex: str, *bg_hexes: str, min_ratio: float = 4.5) -> str:
    """Most VisualAssault themes' `foreground`/`textMuted` already read
    fine against their own `background`/`surface` — but not all: e.g.
    "bubblegum" pairs white foreground text (#ffffff) with a hot-pink
    background (#ff69b4), a 2.65:1 ratio, well under WCAG AA's 4.5:1 for
    body text. Falls back to a computed black/white — whichever contrasts
    better across *every* given background — only where the theme's own
    choice would actually be hard to read against at least one of them,
    so themes that are already fine keep their authored color untouched."""
    if all(_contrast_ratio(bg, preferred_fg_hex) >= min_ratio for bg in bg_hexes):
        return preferred_fg_hex
    worst_case = lambda candidate: min(_contrast_ratio(bg, candidate) for bg in bg_hexes)
    return max(("#000000", "#ffffff"), key=worst_case)


def _elevated_shade(hex_color: str, foreground: str, min_ratio: float = 4.5) -> str:
    """A tone distinct from `hex_color` for "container" roles (chip/badge
    backgrounds), nudged toward whichever extreme (black/white) contrasts
    better against `foreground` — so text already tuned to read on
    `hex_color` keeps at least as much contrast against the container.
    Starts at a subtle 16% nudge (visually "elevated", not just inverted)
    and only pushes further if that's not yet enough to stay readable."""
    target = 0.0 if _readable_on(foreground) == "#000000" else 255.0
    r, g, b = _hex_to_rgb(hex_color)
    for amount in (0.16, 0.30, 0.45, 0.65, 0.85):
        shaded = _rgb_to_hex(tuple(c + (target - c) * amount for c in (r, g, b)))
        if _contrast_ratio(shaded, foreground) >= min_ratio:
            return shaded
    return shaded


def get_theme(theme_id: str) -> ft.Theme | None:
    """ft.ColorScheme has no "background" field on flet 0.86.x (Material 3
    dropped the background/on_background pair) — callers must also set
    `page.bgcolor = get_theme_background(theme_id)` separately."""
    theme = THEMES.get(theme_id)
    if theme is None:
        return None

    surface = theme["surface"]
    primary = theme["primary"]
    secondary = theme["accentBlue"]
    error = theme["accentRed"]

    # Body text needs to read against both the page background and card
    # surfaces — fall back off the theme's own foreground/textMuted only
    # where either pairing is actually too low-contrast to read (e.g.
    # "bubblegum"'s white foreground on its hot-pink background is only
    # 2.65:1 — well under WCAG AA's 4.5:1 for body text).
    foreground = _best_readable(theme["foreground"], theme["background"], surface)
    container_highest = _elevated_shade(surface, foreground)
    text_muted = _best_readable(theme["textMuted"], surface, container_highest)

    return ft.Theme(
        color_scheme=ft.ColorScheme(
            primary=primary,
            on_primary=_readable_on(primary),
            primary_container=theme["primaryHover"],
            on_primary_container=_readable_on(theme["primaryHover"]),
            secondary=secondary,
            on_secondary=_readable_on(secondary),
            secondary_container=surface,
            on_secondary_container=foreground,
            surface=surface,
            on_surface=foreground,
            on_surface_variant=text_muted,
            surface_container_highest=container_highest,
            surface_container_high=surface,
            surface_container=surface,
            surface_container_low=surface,
            surface_container_lowest=surface,
            outline=theme["border"],
            outline_variant=theme["border"],
            error=error,
            on_error=_readable_on(error),
            error_container=surface,
            on_error_container=error,
        ),
        # Material 3's default ElevatedButton/OutlinedButton/TextButton/
        # IconButton styles read `color_scheme.primary` for their label —
        # correct for a *filled* button (paired with `on_primary` for the
        # label), but wrong for outlined/text/icon buttons, which show
        # that label directly on the page/card background rather than on
        # a primary-colored fill. Styling each explicitly, once, here
        # fixes every button in the app instead of every call site.
        # Flutter 3.41+ defaults Material buttons to BASIC (arrow) on
        # desktop — restore the pointing-hand cursor app-wide.
        _click = ft.MouseCursor.CLICK
        button_theme=ft.ButtonTheme(
            style=ft.ButtonStyle(
                bgcolor=primary, color=_readable_on(primary), mouse_cursor=_click,
            )
        ),
        outlined_button_theme=ft.OutlinedButtonTheme(
            style=ft.ButtonStyle(
                color=foreground,
                side=ft.BorderSide(width=1, color=theme["border"]),
                mouse_cursor=_click,
            )
        ),
        text_button_theme=ft.TextButtonTheme(
            style=ft.ButtonStyle(color=foreground, mouse_cursor=_click)
        ),
        icon_button_theme=ft.IconButtonTheme(
            style=ft.ButtonStyle(color=foreground, mouse_cursor=_click)
        ),
        # Cards/dialogs default to a Material tonal-elevation color we
        # never define (no `surface_tint`/seed color here), not to
        # `color_scheme.surface` — pin them explicitly so every card
        # (mapping list, run history) and dialog (delete/undo confirms,
        # DB-relocate prompts) actually shows the theme's surface color
        # instead of a generic default that may not even be dark.
        card_theme=ft.CardTheme(color=surface),
        dialog_theme=ft.DialogTheme(bgcolor=surface),
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
