"""A single mapping's summary card on the Mappings view: name, the
source -> destination flow, schedule/conflict/filter badges, recent-run
stats, and actions. Reads are cheap local SQLite queries, so it's fine to
rebuild this from scratch on every navigation."""
from datetime import datetime
from pathlib import Path

import flet as ft

from fileshuttle.db import repository as repo
from fileshuttle.db.repository import MappingRecord
from fileshuttle.engine.models import FilterRule
from fileshuttle.services.run_service import execute_mapping

_CONFLICT_LABELS = {
    "skip": "Skip duplicates",
    "overwrite": "Overwrite duplicates",
    "auto_rename": "Keep both (rename)",
}


def schedule_summary(record: MappingRecord) -> str:
    if record.schedule_type == "interval":
        return f"Every {record.schedule_interval_minutes} min"
    if record.schedule_type == "daily_at":
        return f"Daily at {record.schedule_daily_time}"
    return "Manual only"


def _format_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{num_bytes} B"


def _describe_filter(rule: FilterRule) -> str:
    if rule.field == "extension":
        return f"*.{rule.value.lstrip('.')}"
    if rule.field == "filename_glob":
        return f"name matches {rule.value}"
    if rule.field == "filename_regex":
        return f"name matches /{rule.value}/"
    if rule.field == "size":
        size_str = _format_size(int(rule.value)) if rule.value.isdigit() else rule.value
        return f"size {'≥' if rule.operator == 'min' else '≤'} {size_str}"
    if rule.field in ("modified_date", "created_date"):
        label = "modified" if rule.field == "modified_date" else "created"
        return f"{label} {rule.operator} {rule.value}"
    return f"{rule.field} {rule.operator} {rule.value}"


def _relative_time(iso_str: str) -> str:
    try:
        when = datetime.fromisoformat(iso_str)
    except ValueError:
        return iso_str
    seconds = (datetime.now() - when).total_seconds()
    if seconds < 60:
        return "just now"
    minutes = seconds / 60
    if minutes < 60:
        return f"{int(minutes)} min ago"
    hours = minutes / 60
    if hours < 24:
        return f"{int(hours)} hr ago"
    days = hours / 24
    if days < 7:
        return f"{int(days)} day{'s' if days >= 2 else ''} ago"
    return when.strftime("%Y-%m-%d")


def _stats_line(run_count: int, last_run) -> str:
    if last_run is None:
        stats = "Never run"
    else:
        stats = (
            f"Last run {_relative_time(last_run.started_at)} — moved {last_run.files_moved}, "
            f"skipped {last_run.files_skipped}, errored {last_run.files_errored}"
        )
    run_count_label = f"{run_count} run" + ("s" if run_count != 1 else "") + " total"
    return f"{stats}   ·   {run_count_label}"


def _path_chip(text: str) -> ft.Container:
    return ft.Container(
        padding=ft.Padding(6, 2, 6, 2),
        border_radius=4,
        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
        content=ft.Text(text, size=11, font_family="monospace"),
    )


def _breadcrumb_row(icon: str, label: str, path_str: str) -> ft.Control:
    """Every path segment as its own chip, chevron-separated - a folder
    picked deep in a tree reads as a sequence of levels rather than one
    long unbroken string."""
    controls: list[ft.Control] = [
        ft.Icon(icon, size=15, color=ft.Colors.ON_SURFACE_VARIANT),
        ft.Text(label, size=11, weight=ft.FontWeight.BOLD, color=ft.Colors.ON_SURFACE_VARIANT),
    ]
    parts = Path(path_str).parts
    for i, part in enumerate(parts):
        controls.append(_path_chip(part))
        if i < len(parts) - 1:
            controls.append(ft.Icon(ft.Icons.CHEVRON_RIGHT, size=12, color=ft.Colors.ON_SURFACE_VARIANT))
    return ft.Row(controls=controls, wrap=True, spacing=2, run_spacing=4)


def _pill(icon: str, text: str) -> ft.Container:
    return ft.Container(
        padding=ft.Padding(8, 4, 8, 4),
        border_radius=6,
        bgcolor=ft.Colors.SURFACE_CONTAINER_HIGHEST,
        content=ft.Row(
            spacing=4,
            controls=[ft.Icon(icon, size=14, color=ft.Colors.ON_SURFACE_VARIANT), ft.Text(text, size=12)],
        ),
    )


def build(state, record: MappingRecord) -> ft.Card:
    status_text = ft.Text(size=12, color=ft.Colors.ON_SURFACE_VARIANT)
    run_count, last_run = repo.get_run_stats(state.conn, record.id)
    stats_text = ft.Text(_stats_line(run_count, last_run), size=12, color=ft.Colors.ON_SURFACE_VARIANT)

    def run_now(e):
        run_button.disabled = True
        run_button.text = "Running..."
        state.page.update()
        try:
            result = execute_mapping(state.conn, record.id, "manual")
            status_text.value = (
                f"Moved {result.files_moved}, skipped {result.files_skipped}, "
                f"errored {result.files_errored}"
            )
            new_count, new_last_run = repo.get_run_stats(state.conn, record.id)
            stats_text.value = _stats_line(new_count, new_last_run)
        except Exception as exc:
            status_text.value = f"Run failed: {exc}"
        run_button.disabled = False
        run_button.text = "Run Now"
        state.page.update()

    def toggle_enabled(e):
        repo.set_mapping_enabled(state.conn, record.id, e.control.value)
        state.scheduler.reload_jobs()
        state.show_mappings()

    def edit(e):
        state.show_mapping_editor(record.id)

    def confirm_delete(e):
        def do_delete(e):
            repo.delete_mapping(state.conn, record.id)
            state.scheduler.reload_jobs()
            state.page.pop_dialog()
            state.show_mappings()

        def cancel(e):
            state.page.pop_dialog()

        state.page.show_dialog(
            ft.AlertDialog(
                modal=True,
                title=ft.Text("Delete mapping?"),
                content=ft.Text(f'"{record.name}" and its run history will be permanently deleted.'),
                actions=[
                    ft.TextButton("Cancel", on_click=cancel),
                    ft.TextButton("Delete", on_click=do_delete),
                ],
            )
        )

    run_button = ft.ElevatedButton("Run Now", icon=ft.Icons.PLAY_ARROW, on_click=run_now)

    # --- source -> destination flow, each path level as its own chip ---
    dest_row = _breadcrumb_row(ft.Icons.FOLDER, "To", record.dest_path)
    if record.recursive:
        dest_row.controls.append(
            ft.Icon(ft.Icons.ACCOUNT_TREE, size=14, color=ft.Colors.ON_SURFACE_VARIANT,
                    tooltip="Includes subfolders")
        )
    path_section = ft.Column(
        spacing=4,
        controls=[
            _breadcrumb_row(ft.Icons.FOLDER_OPEN, "From", record.source_path),
            dest_row,
        ],
    )

    # --- schedule / conflict / filter badges ---
    badges = [
        _pill(ft.Icons.SCHEDULE, schedule_summary(record)),
        _pill(ft.Icons.MERGE_TYPE, _CONFLICT_LABELS.get(record.conflict_policy, record.conflict_policy)),
    ]
    if record.filters:
        mode_label = "ALL" if record.filter_match_mode == "all" else "ANY"
        count_label = f"{len(record.filters)} filter" + ("s" if len(record.filters) != 1 else "")
        badges.append(_pill(ft.Icons.FILTER_ALT, f"{count_label} · match {mode_label}"))
    else:
        badges.append(_pill(ft.Icons.FILTER_ALT_OFF, "All files"))
    if record.next_mapping_id is not None:
        next_record = repo.get_mapping(state.conn, record.next_mapping_id)
        next_name = next_record.name if next_record else "(deleted mapping)"
        badges.append(_pill(ft.Icons.ARROW_FORWARD, f"Then runs: {next_name}"))
    badges_row = ft.Row(controls=badges, wrap=True, spacing=6)

    enabled_label = ft.Text("Enabled" if record.enabled else "Disabled", size=12,
                             color=ft.Colors.ON_SURFACE_VARIANT)

    body: list[ft.Control] = [
        ft.Row(
            controls=[
                ft.Text(record.name, weight=ft.FontWeight.BOLD, size=16, expand=True),
                enabled_label,
                ft.Switch(value=record.enabled, on_change=toggle_enabled),
            ],
        ),
        path_section,
        badges_row,
    ]
    if record.filters:
        body.append(
            ft.Row(
                wrap=True, spacing=10,
                controls=[
                    ft.Text(f"· {_describe_filter(f)}", size=11, color=ft.Colors.ON_SURFACE_VARIANT)
                    for f in record.filters
                ],
            )
        )

    body.append(stats_text)
    body.append(status_text)
    body.append(
        ft.Row(
            alignment=ft.MainAxisAlignment.SPACE_BETWEEN,
            controls=[
                run_button,
                ft.Row(
                    controls=[
                        ft.IconButton(icon=ft.Icons.EDIT, tooltip="Edit mapping", on_click=edit),
                        ft.IconButton(icon=ft.Icons.DELETE_OUTLINE, tooltip="Delete mapping",
                                      icon_color=ft.Colors.ERROR, on_click=confirm_delete),
                    ],
                ),
            ],
        )
    )

    return ft.Card(
        content=ft.Container(
            padding=16,
            content=ft.Column(spacing=8, controls=body),
        ),
    )
