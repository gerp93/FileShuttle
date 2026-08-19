import flet as ft

from fileshuttle.db import repository as repo
from fileshuttle.services.run_service import execute_all_enabled
from fileshuttle.ui.components import mapping_card


def _matches(record, query: str) -> bool:
    query = query.strip().lower()
    if not query:
        return True
    return query in record.name.lower() or query in record.source_path.lower() or query in record.dest_path.lower()


def build(state) -> ft.Control:
    records = repo.list_mappings(state.conn)
    summary_text = ft.Text("", size=12, color=ft.Colors.ON_SURFACE_VARIANT)
    list_column = ft.Column(controls=[], scroll=ft.ScrollMode.AUTO, expand=True)

    def new_mapping(e):
        state.show_mapping_editor(None)

    def run_all(e):
        run_all_button.disabled = True
        state.page.update()
        results = execute_all_enabled(state.conn, "manual")
        moved = sum(r.files_moved for _, r in results)
        skipped = sum(r.files_skipped for _, r in results)
        errored = sum(r.files_errored for _, r in results)
        summary_text.value = (
            f"Ran {len(results)} enabled mapping(s): "
            f"moved {moved}, skipped {skipped}, errored {errored}"
        )
        run_all_button.disabled = False
        state.show_mappings()

    def apply_filter():
        matching = [r for r in records if _matches(r, search_field.value or "")]
        if not records:
            list_column.controls = [ft.Container(
                padding=30,
                content=ft.Text(
                    "No mappings yet. Click \"New Mapping\" to move your first batch of files.",
                    color=ft.Colors.ON_SURFACE_VARIANT,
                ),
            )]
        elif not matching:
            list_column.controls = [ft.Container(
                padding=30,
                content=ft.Text(f'No mappings match "{search_field.value}".', color=ft.Colors.ON_SURFACE_VARIANT),
            )]
        else:
            list_column.controls = [mapping_card.build(state, record) for record in matching]

    def refresh_list(e=None):
        apply_filter()
        list_column.update()

    run_all_button = ft.ElevatedButton("Run All Enabled", icon=ft.Icons.PLAY_CIRCLE, on_click=run_all)
    search_field = ft.TextField(
        label="Search mappings", hint_text="Filter by name or folder path",
        prefix_icon=ft.Icons.SEARCH, expand=True, on_change=refresh_list,
    )

    apply_filter()

    return ft.Column(
        expand=True,
        controls=[
            ft.Row(
                controls=[
                    ft.Text("Mappings", size=22, weight=ft.FontWeight.BOLD, expand=True),
                    run_all_button,
                    ft.ElevatedButton("New Mapping", icon=ft.Icons.ADD, on_click=new_mapping),
                ],
            ),
            search_field,
            summary_text,
            list_column,
        ],
    )
