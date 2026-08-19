import flet as ft


def build(on_change, logo_image: ft.Image) -> ft.NavigationRail:
    header = ft.Container(
        padding=ft.Padding(0, 16, 0, 16),
        content=ft.Column(
            horizontal_alignment=ft.CrossAxisAlignment.CENTER,
            controls=[
                logo_image,
                ft.Text("FileShuttle", size=13, weight=ft.FontWeight.BOLD),
            ],
        ),
    )
    return ft.NavigationRail(
        selected_index=0,
        label_type=ft.NavigationRailLabelType.ALL,
        min_width=90,
        min_extended_width=180,
        leading=header,
        destinations=[
            ft.NavigationRailDestination(icon=ft.Icons.SWAP_HORIZ, label="Mappings"),
            ft.NavigationRailDestination(icon=ft.Icons.HISTORY, label="History"),
            ft.NavigationRailDestination(icon=ft.Icons.SETTINGS, label="Settings"),
        ],
        on_change=on_change,
    )
