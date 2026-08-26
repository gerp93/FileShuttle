"""Create/edit view for a single mapping. Reused for both create
(mapping_id=None) and edit."""
import re

import flet as ft

from fileshuttle.db import repository as repo
from fileshuttle.engine.models import FilterRule
from fileshuttle.ui.components.filter_row import FilterRowControl

CONFLICT_POLICIES = [
    ("skip", "Skip existing files"),
    ("overwrite", "Overwrite existing files"),
    ("auto_rename", "Auto-rename (keep both)"),
]

SCHEDULE_TYPES = [
    ("manual", "Manual only"),
    ("interval", "Every N minutes"),
    ("daily_at", "Daily at a specific time"),
]

FILTER_MATCH_MODES = [
    ("all", "Match ALL filters (AND)"),
    ("any", "Match ANY filter (OR)"),
]

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def build(state, mapping_id: int | None) -> ft.Control:
    record = repo.get_mapping(state.conn, mapping_id) if mapping_id else None
    is_new = record is None

    name_field = ft.TextField(label="Mapping name", value=record.name if record else "", expand=True)
    source_field = ft.TextField(label="Source folder", value=record.source_path if record else "",
                                 read_only=True, expand=True)
    dest_field = ft.TextField(label="Destination folder", value=record.dest_path if record else "",
                               read_only=True, expand=True)
    recursive_switch = ft.Switch(label="Include subfolders (recursive)",
                                  value=record.recursive if record else False)
    enabled_switch = ft.Switch(label="Enabled", value=record.enabled if record else True)
    conflict_dropdown = ft.Dropdown(
        label="If a file already exists at the destination", width=320,
        value=record.conflict_policy if record else "skip",
        options=[ft.DropdownOption(key=k, text=t) for k, t in CONFLICT_POLICIES],
    )

    interval_field = ft.TextField(
        label="Interval (minutes)", width=200,
        value=str(record.schedule_interval_minutes) if record and record.schedule_interval_minutes else "30",
        keyboard_type=ft.KeyboardType.NUMBER,
    )
    daily_time_field = ft.TextField(
        label="Time (HH:MM, 24-hour)", width=200,
        value=record.schedule_daily_time if record and record.schedule_daily_time else "09:00",
    )
    schedule_value_row = ft.Row(controls=[])

    def refresh_schedule_value_row():
        schedule_type = schedule_dropdown.value
        if schedule_type == "interval":
            schedule_value_row.controls = [interval_field]
        elif schedule_type == "daily_at":
            schedule_value_row.controls = [daily_time_field]
        else:
            schedule_value_row.controls = []

    def on_schedule_type_change(e):
        refresh_schedule_value_row()
        schedule_value_row.update()

    schedule_dropdown = ft.Dropdown(
        label="Schedule", width=250,
        value=record.schedule_type if record else "manual",
        options=[ft.DropdownOption(key=k, text=t) for k, t in SCHEDULE_TYPES],
        on_select=on_schedule_type_change,
    )
    refresh_schedule_value_row()

    other_mappings = [m for m in repo.list_mappings(state.conn) if not record or m.id != record.id]
    next_mapping_dropdown = ft.Dropdown(
        label="When this finishes, then run", width=320,
        value=str(record.next_mapping_id) if record and record.next_mapping_id else "",
        options=[ft.DropdownOption(key="", text="Nothing — run independently")]
        + [ft.DropdownOption(key=str(m.id), text=m.name) for m in other_mappings],
    )

    error_text = ft.Text(color=ft.Colors.ERROR)

    # --- folder pickers ---
    source_picker = ft.FilePicker()
    dest_picker = ft.FilePicker()
    state.page.services.append(source_picker)
    state.page.services.append(dest_picker)

    async def browse_source(e):
        path = await source_picker.get_directory_path(dialog_title="Choose source folder")
        if path:
            source_field.value = path
            source_field.update()

    async def browse_dest(e):
        path = await dest_picker.get_directory_path(dialog_title="Choose destination folder")
        if path:
            dest_field.value = path
            dest_field.update()

    # --- filter rows ---
    match_mode_dropdown = ft.Dropdown(
        label="Match", width=260,
        value=record.filter_match_mode if record else "all",
        options=[ft.DropdownOption(key=k, text=t) for k, t in FILTER_MATCH_MODES],
    )
    filter_rows: list[FilterRowControl] = []
    filter_rows_column = ft.Column(controls=[])

    def remove_filter_row(row: FilterRowControl):
        filter_rows.remove(row)
        filter_rows_column.controls = [r.row for r in filter_rows]
        filter_rows_column.update()

    def add_filter_row(e=None, initial: FilterRule | None = None):
        row = FilterRowControl(on_remove=remove_filter_row, initial=initial)
        filter_rows.append(row)
        filter_rows_column.controls = [r.row for r in filter_rows]
        filter_rows_column.update()

    for f in (record.filters if record else []):
        add_filter_row(initial=f)

    # --- save/cancel ---
    def _remove_pickers():
        for picker in (source_picker, dest_picker):
            if picker in state.page.services:
                state.page.services.remove(picker)

    def save(e):
        name = (name_field.value or "").strip()
        source_path = (source_field.value or "").strip()
        dest_path = (dest_field.value or "").strip()

        if not name or not source_path or not dest_path:
            error_text.value = "Name, source folder, and destination folder are all required."
            error_text.update()
            return

        schedule_type = schedule_dropdown.value
        schedule_interval_minutes = None
        schedule_daily_time = None
        if schedule_type == "interval":
            if not (interval_field.value or "").strip().isdigit():
                error_text.value = "Interval must be a whole number of minutes."
                error_text.update()
                return
            schedule_interval_minutes = int(interval_field.value.strip())
        elif schedule_type == "daily_at":
            if not _TIME_RE.match((daily_time_field.value or "").strip()):
                error_text.value = "Time must be in HH:MM 24-hour format, e.g. 09:00."
                error_text.update()
                return
            schedule_daily_time = daily_time_field.value.strip()

        filters = [row.to_filter_rule() for row in filter_rows]
        kwargs = dict(
            name=name, source_path=source_path, dest_path=dest_path,
            recursive=recursive_switch.value, conflict_policy=conflict_dropdown.value,
            enabled=enabled_switch.value, schedule_type=schedule_type,
            schedule_interval_minutes=schedule_interval_minutes,
            schedule_daily_time=schedule_daily_time, filters=filters,
            filter_match_mode=match_mode_dropdown.value,
            next_mapping_id=int(next_mapping_dropdown.value) if next_mapping_dropdown.value else None,
        )
        if is_new:
            repo.create_mapping(state.conn, **kwargs)
        else:
            repo.update_mapping(state.conn, mapping_id, **kwargs)

        state.scheduler.reload_jobs()
        _remove_pickers()
        state.show_mappings()

    def cancel(e):
        _remove_pickers()
        state.show_mappings()

    return ft.Column(
        expand=True,
        scroll=ft.ScrollMode.AUTO,
        controls=[
            ft.Text("New Mapping" if is_new else "Edit Mapping", size=22, weight=ft.FontWeight.BOLD),
            name_field,
            ft.Row(controls=[source_field, ft.IconButton(icon=ft.Icons.FOLDER_OPEN, tooltip="Browse",
                                                           on_click=browse_source)]),
            ft.Row(controls=[dest_field, ft.IconButton(icon=ft.Icons.FOLDER_OPEN, tooltip="Browse",
                                                         on_click=browse_dest)]),
            recursive_switch,
            conflict_dropdown,
            enabled_switch,
            ft.Divider(),
            ft.Row(controls=[schedule_dropdown]),
            schedule_value_row,
            ft.Divider(),
            ft.Row(controls=[next_mapping_dropdown]),
            ft.Divider(),
            ft.Row(
                controls=[
                    ft.Text("Filters (leave empty to move every file)", size=14, expand=True),
                    match_mode_dropdown,
                    ft.TextButton("Add Filter", icon=ft.Icons.ADD, on_click=add_filter_row),
                ],
            ),
            filter_rows_column,
            ft.Divider(),
            error_text,
            ft.Row(
                controls=[
                    ft.ElevatedButton("Save", icon=ft.Icons.SAVE, on_click=save),
                    ft.TextButton("Cancel", on_click=cancel),
                ],
            ),
        ],
    )
