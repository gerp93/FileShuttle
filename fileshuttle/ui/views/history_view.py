import flet as ft

from fileshuttle.db import repository as repo
from fileshuttle.services.run_service import execute_undo
from fileshuttle.ui.os_utils import open_folder

_STATUS_COLORS = {
    "success": ft.Colors.GREEN,
    "partial": ft.Colors.AMBER,
    "error": ft.Colors.RED,
}

_TRIGGER_LABELS = {
    "manual": "manual",
    "scheduled": "scheduled",
    "undo": "undo",
}


def build(state) -> ft.Control:
    mappings = repo.list_mappings(state.conn)

    filter_dropdown = ft.Dropdown(
        label="Mapping", width=280, value="all",
        options=[ft.DropdownOption(key="all", text="All mappings")]
        + [ft.DropdownOption(key=str(m.id), text=m.name) for m in mappings],
    )

    runs_column = ft.Column(controls=[], scroll=ft.ScrollMode.AUTO, expand=True)

    def undo(run):
        def do_undo(e):
            state.page.pop_dialog()
            result = execute_undo(state.conn, run.id)
            state.page.show_dialog(ft.SnackBar(ft.Text(
                f"Undo finished: moved back {result.files_moved}, "
                f"skipped {result.files_skipped}, errored {result.files_errored}."
            )))
            refresh()

        def cancel(e):
            state.page.pop_dialog()

        state.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                title=ft.Text("Undo this run?"),
                content=ft.Text(
                    f"This will move {run.files_moved} file(s) back to where "
                    f'"{run.mapping_name_snapshot}" originally moved them from.'
                ),
                actions=[
                    ft.TextButton("Cancel", on_click=cancel),
                    ft.TextButton("Undo", on_click=do_undo),
                ],
            )
        )

    def build_run_row(run) -> ft.Control:
        detail_column = ft.Column(controls=[], visible=False)
        chevron = ft.Icon(ft.Icons.KEYBOARD_ARROW_DOWN, size=20)
        loaded = False

        def toggle(e):
            nonlocal loaded
            if not loaded:
                detail = repo.get_run_detail(state.conn, run.id)
                if not detail:
                    detail_column.controls = [ft.Text("No file detail recorded for this run.", size=12)]
                else:
                    detail_column.controls = [
                        ft.Text(
                            f"{d.outcome.upper():8} {d.source_path}"
                            + (f"  →  {d.dest_path}" if d.dest_path else "")
                            + (f"  ({d.reason})" if d.reason else ""),
                            size=12, font_family="monospace",
                        )
                        for d in detail
                    ]
                loaded = True
            detail_column.visible = not detail_column.visible
            chevron.icon = ft.Icons.KEYBOARD_ARROW_UP if detail_column.visible else ft.Icons.KEYBOARD_ARROW_DOWN
            detail_column.update()
            chevron.update()

        mapping = repo.get_mapping(state.conn, run.mapping_id)

        action_controls: list[ft.Control] = []
        if mapping is not None:
            action_controls.append(ft.IconButton(
                icon=ft.Icons.FOLDER_OPEN, tooltip=f"Open source folder\n{mapping.source_path}",
                on_click=lambda e: open_folder(mapping.source_path),
            ))
            if mapping.action_type in ("move", "copy"):
                action_controls.append(ft.IconButton(
                    icon=ft.Icons.FOLDER, tooltip=f"Open destination folder\n{mapping.dest_path}",
                    on_click=lambda e: open_folder(mapping.dest_path),
                ))
        if run.undone_by_run_id is not None:
            action_controls.append(ft.Text("Undone", size=12, italic=True, color=ft.Colors.ON_SURFACE_VARIANT))
        elif run.files_moved > 0:
            action_controls.append(ft.TextButton("Undo", icon=ft.Icons.UNDO, on_click=lambda e: undo(run)))
        action: ft.Control = ft.Row(controls=action_controls, spacing=0)

        header = ft.Container(
            padding=10,
            content=ft.Row(
                controls=[
                    ft.Container(
                        on_click=toggle,
                        expand=True,
                        content=ft.Row(
                            controls=[
                                chevron,
                                ft.Column(
                                    expand=True,
                                    spacing=4,
                                    controls=[
                                        ft.Row(
                                            wrap=True,
                                            controls=[
                                                ft.Container(
                                                    content=ft.Text(run.status.upper(), size=11,
                                                                     color=ft.Colors.WHITE),
                                                    bgcolor=_STATUS_COLORS.get(run.status, ft.Colors.GREY),
                                                    padding=ft.Padding(8, 2, 8, 2), border_radius=4,
                                                ),
                                                ft.Text(run.mapping_name_snapshot, weight=ft.FontWeight.BOLD),
                                            ],
                                        ),
                                        ft.Row(
                                            wrap=True,
                                            controls=[
                                                ft.Text(
                                                    f"({_TRIGGER_LABELS.get(run.trigger_type, run.trigger_type)}"
                                                    + (", chained" if run.triggered_by_run_id is not None else "")
                                                    + ")",
                                                    size=12, color=ft.Colors.ON_SURFACE_VARIANT,
                                                ),
                                                ft.Text(run.started_at, size=12, color=ft.Colors.ON_SURFACE_VARIANT),
                                                ft.Text(
                                                    (
                                                        f"deleted {run.files_deleted}"
                                                        if run.files_deleted
                                                        else f"copied {run.files_copied}"
                                                        if run.files_copied
                                                        else f"moved {run.files_moved}"
                                                    )
                                                    + f" / skipped {run.files_skipped} / errored {run.files_errored}",
                                                    size=12,
                                                ),
                                            ],
                                        ),
                                    ],
                                ),
                            ],
                        ),
                    ),
                    action,
                ],
            ),
        )
        return ft.Card(content=ft.Column(controls=[header, ft.Container(padding=ft.Padding(20, 0, 10, 10),
                                                                          content=detail_column)]))

    def refresh(e=None):
        mapping_id = None if filter_dropdown.value in (None, "all") else int(filter_dropdown.value)
        runs = repo.list_runs(state.conn, mapping_id=mapping_id)
        if not runs:
            runs_column.controls = [ft.Container(
                padding=30,
                content=ft.Text("No runs yet.", color=ft.Colors.ON_SURFACE_VARIANT),
            )]
        else:
            runs_column.controls = [build_run_row(run) for run in runs]
        runs_column.update()

    filter_dropdown.on_select = refresh
    initial_runs = repo.list_runs(state.conn)
    runs_column.controls = (
        [build_run_row(run) for run in initial_runs]
        if initial_runs
        else [ft.Container(padding=30, content=ft.Text("No runs yet.", color=ft.Colors.ON_SURFACE_VARIANT))]
    )

    return ft.Column(
        expand=True,
        controls=[
            ft.Text("History", size=22, weight=ft.FontWeight.BOLD),
            filter_dropdown,
            runs_column,
        ],
    )
