import flet as ft

from fileshuttle.db import repository as repo
from fileshuttle.db.connection import close_connection, db_location, restart_app
from fileshuttle.services import startup
from fileshuttle.ui import theming, updater


def build(state) -> ft.Control:
    # --- database location ---
    current_path_text = ft.Text(str(db_location.get_effective_db_path()), size=13,
                                 font_family="monospace", selectable=True)

    existing_picker = ft.FilePicker()
    new_location_picker = ft.FilePicker()
    state.page.services.append(existing_picker)
    state.page.services.append(new_location_picker)

    def _confirm_and_relocate(message: str, apply_fn):
        def do_it(e):
            state.page.pop_dialog()
            close_connection()
            apply_fn()
            restart_app()

        def cancel(e):
            state.page.pop_dialog()

        state.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                title=ft.Text("Restart required"),
                content=ft.Text(message),
                actions=[
                    ft.TextButton("Cancel", on_click=cancel),
                    ft.TextButton("Continue", on_click=do_it),
                ],
            )
        )

    async def use_existing_file(e):
        files = await existing_picker.pick_files(
            dialog_title="Choose an existing FileShuttle database file",
            file_type=ft.FilePickerFileType.CUSTOM, allowed_extensions=["db"],
        )
        if not files or not files[0].path:
            return
        chosen_path = files[0].path
        _confirm_and_relocate(
            f"FileShuttle will restart and use the database at:\n{chosen_path}",
            lambda: db_location.set_db_path(chosen_path),
        )

    async def move_to_new_location(e):
        chosen_path = await new_location_picker.save_file(
            dialog_title="Choose a new location for the FileShuttle database",
            file_name="fileshuttle.db",
        )
        if not chosen_path:
            return
        _confirm_and_relocate(
            f"FileShuttle will copy the current database to:\n{chosen_path}\nand restart.",
            lambda: db_location.set_db_path(chosen_path),
        )

    def reset_to_default(e):
        _confirm_and_relocate(
            "FileShuttle will restart and use the default database location.",
            db_location.reset_to_default_db_path,
        )

    # --- update check ---
    update_status_text = ft.Text("", size=13)
    apply_update_button = ft.ElevatedButton("Download && Apply Update", visible=False)

    def check_for_update(e):
        update = updater.check_for_update()
        if update is None:
            update_status_text.value = (
                "Up to date (or running from source — update checks only apply to packaged builds)."
            )
            apply_update_button.visible = False
        else:
            update_status_text.value = f"Update available: {update.get('version', 'unknown version')}"
            apply_update_button.visible = True
            apply_update_button.on_click = lambda e: updater.check_and_apply_update(update)
        update_status_text.update()
        apply_update_button.update()

    # --- theme picker ---
    current_theme = repo.get_setting(state.conn, "theme", theming.DEFAULT_THEME_ID)

    def on_theme_change(e):
        theme_id = theme_dropdown.value
        repo.set_setting(state.conn, "theme", theme_id)
        theming.apply_theme(state.page, theme_id)
        state.page.update()

    theme_dropdown = ft.Dropdown(
        label="Theme", width=280, value=current_theme,
        options=[ft.DropdownOption(key=k, text=t) for k, t in theming.get_theme_list()],
        on_select=on_theme_change,
    )

    # --- startup & background ---
    def on_startup_toggle_change(e):
        startup.set_enabled(e.control.value)

    startup_switch = ft.Switch(
        label="Start FileShuttle when Windows starts",
        value=startup.is_enabled(),
        disabled=not startup.is_supported,
        on_change=on_startup_toggle_change,
    )
    startup_section: list[ft.Control] = [
        ft.Text("Startup & Background", size=16, weight=ft.FontWeight.BOLD),
        startup_switch,
        ft.Text(
            "Closing this window keeps FileShuttle running in the background (system tray) "
            "so scheduled mappings keep firing. Use the tray icon to reopen the window or quit.",
            size=12, color=ft.Colors.ON_SURFACE_VARIANT,
        ),
    ]
    if not startup.is_supported:
        startup_section.append(
            ft.Text("Start-at-login isn't supported on this platform yet.", size=12,
                    color=ft.Colors.ON_SURFACE_VARIANT)
        )

    return ft.Column(
        expand=True,
        scroll=ft.ScrollMode.AUTO,
        controls=[
            ft.Text("Settings", size=22, weight=ft.FontWeight.BOLD),
            ft.Divider(),
            *startup_section,
            ft.Divider(),
            ft.Text("Appearance", size=16, weight=ft.FontWeight.BOLD),
            theme_dropdown,
            ft.Divider(),
            ft.Text("Database Location", size=16, weight=ft.FontWeight.BOLD),
            current_path_text,
            ft.Row(
                controls=[
                    ft.OutlinedButton("Use Existing Database File", on_click=use_existing_file),
                    ft.OutlinedButton("Move Database To New Location", on_click=move_to_new_location),
                    ft.OutlinedButton("Reset to Default Location", on_click=reset_to_default),
                ],
                wrap=True,
            ),
            ft.Divider(),
            ft.Text("Updates", size=16, weight=ft.FontWeight.BOLD),
            ft.Row(controls=[ft.OutlinedButton("Check for Updates", on_click=check_for_update)]),
            update_status_text,
            apply_update_button,
        ],
    )
