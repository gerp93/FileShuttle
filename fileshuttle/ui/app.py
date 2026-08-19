"""Flet app shell: nav rail + content area, wired to the DB connection and
scheduler. `main.py` is the actual entry point (`ft.run(...)`).

Closing the window hides it to the system tray instead of exiting, so
scheduled mappings keep firing without the window being open — see
`ui/tray.py`. Only the tray's "Quit" item (or `os._exit`) actually ends
the process.
"""
import logging
import os

import flet as ft

from fileshuttle.db import repository as repo
from fileshuttle.db.connection import get_connection
from fileshuttle.scheduler.scheduler import SchedulerService
from fileshuttle.services.run_service import execute_mapping
from fileshuttle.ui import theming, updater
from fileshuttle.ui.components import nav_rail
from fileshuttle.ui.state import AppState
from fileshuttle.ui.tray import TrayManager
from fileshuttle.ui.views import history_view, mapping_editor_view, mappings_view, settings_view

logger = logging.getLogger(__name__)


def main(page: ft.Page, start_hidden: bool = False) -> None:
    page.title = "FileShuttle"
    page.window.width = 1100
    page.window.height = 750

    conn = get_connection()

    page.window.icon = "icon.ico"

    theme_id = repo.get_setting(conn, "theme", theming.DEFAULT_THEME_ID)
    if not theming.theme_exists(theme_id):
        theme_id = theming.DEFAULT_THEME_ID
    theming.apply_theme(page, theme_id)

    logo_image = ft.Image(src="icon.png", width=40, height=40)

    content = ft.Column(expand=True, scroll=ft.ScrollMode.AUTO)

    def show_mappings():
        content.controls = [mappings_view.build(state)]
        page.update()

    def show_history():
        content.controls = [history_view.build(state)]
        page.update()

    def show_settings():
        content.controls = [settings_view.build(state)]
        page.update()

    def show_mapping_editor(mapping_id):
        content.controls = [mapping_editor_view.build(state, mapping_id)]
        page.update()

    def notify_scheduled_run_complete(mapping_id: int, result) -> None:
        record = repo.get_mapping(conn, mapping_id)
        mapping_name = record.name if record else f"mapping #{mapping_id}"
        tray.notify(
            "FileShuttle: scheduled run finished",
            f'"{mapping_name}" — moved {result.files_moved}, '
            f"skipped {result.files_skipped}, errored {result.files_errored}",
        )

    scheduler = SchedulerService(conn, execute_mapping, on_scheduled_run_complete=notify_scheduled_run_complete)

    state = AppState(
        page=page,
        conn=conn,
        scheduler=scheduler,
        show_mappings=show_mappings,
        show_history=show_history,
        show_settings=show_settings,
        show_mapping_editor=show_mapping_editor,
    )

    view_by_index = {0: show_mappings, 1: show_history, 2: show_settings}

    def on_nav_change(e):
        view_by_index[e.control.selected_index]()

    page.add(
        ft.Row(
            expand=True,
            controls=[
                nav_rail.build(on_nav_change, logo_image),
                ft.VerticalDivider(width=1),
                ft.Container(content=content, expand=True, padding=20),
            ],
        )
    )

    # --- background/tray behavior ---
    announced_background = False

    def show_window():
        page.window.visible = True
        page.window.skip_task_bar = False
        page.update()

    def quit_app():
        try:
            scheduler.shutdown(wait=False)
            tray.stop()
        finally:
            os._exit(0)

    tray = TrayManager(on_open=show_window, on_quit=quit_app)

    def on_window_event(e: ft.WindowEvent):
        nonlocal announced_background
        if e.type == ft.WindowEventType.CLOSE:
            page.window.visible = False
            page.window.skip_task_bar = True
            page.update()
            if not announced_background:
                tray.notify(
                    "FileShuttle is still running",
                    "Scheduled mappings keep firing in the background. "
                    "Use the tray icon to reopen or quit.",
                )
                announced_background = True

    page.window.prevent_close = True
    page.window.on_event = on_window_event
    page.window.visible = not start_hidden
    page.update()

    tray.start()
    scheduler.start()

    try:
        update = updater.check_for_update()
        if update is not None:
            page.show_dialog(ft.SnackBar(
                ft.Text(
                    f"An update is available ({update.get('version', 'unknown')}). "
                    "See Settings to download it."
                ),
                duration=ft.Duration(seconds=8),
            ))
    except Exception:
        logger.exception("Update check failed")

    show_mappings()
