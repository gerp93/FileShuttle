"""One row of the mapping editor's dynamic filter-rule list: field +
operator + value, with a remove button. Operator choices (and the value
field's hint) change based on the selected field.
"""
import flet as ft

from fileshuttle.engine.models import FilterRule

FIELD_LABELS = {
    "extension": "File extension",
    "filename_glob": "Filename (wildcard)",
    "filename_regex": "Filename (regex)",
    "size": "File size (bytes)",
    "modified_date": "Modified date",
    "created_date": "Created date",
}

OPERATORS_BY_FIELD = {
    "extension": [("equals", "is")],
    "filename_glob": [("matches", "matches pattern")],
    "filename_regex": [("matches", "matches regex")],
    "size": [("min", "at least"), ("max", "at most")],
    "modified_date": [("before", "before"), ("after", "after")],
    "created_date": [("before", "before"), ("after", "after")],
}

VALUE_HINTS = {
    "extension": "e.g. pdf",
    "filename_glob": "e.g. *.bak",
    "filename_regex": r"e.g. ^invoice_\d+",
    "size": "bytes, e.g. 1048576",
    "modified_date": "YYYY-MM-DD",
    "created_date": "YYYY-MM-DD",
}


class FilterRowControl:
    def __init__(self, on_remove, initial: FilterRule | None = None):
        field = initial.field if initial else "extension"
        operators = OPERATORS_BY_FIELD[field]
        operator = initial.operator if initial else operators[0][0]
        value = initial.value if initial else ""

        self.value_field = ft.TextField(
            label="Value", value=value, hint_text=VALUE_HINTS[field], expand=True,
        )
        self.operator_dropdown = ft.Dropdown(
            label="Operator", width=170, value=operator,
            options=[ft.DropdownOption(key=k, text=t) for k, t in operators],
        )
        self.field_dropdown = ft.Dropdown(
            label="Field", width=190, value=field,
            options=[ft.DropdownOption(key=k, text=t) for k, t in FIELD_LABELS.items()],
            on_select=self._on_field_change,
        )
        self.row = ft.Row(
            controls=[
                self.field_dropdown,
                self.operator_dropdown,
                self.value_field,
                ft.IconButton(icon=ft.Icons.DELETE_OUTLINE, tooltip="Remove filter",
                               on_click=lambda e: on_remove(self)),
            ],
            alignment=ft.MainAxisAlignment.START,
        )

    def _on_field_change(self, e):
        field = self.field_dropdown.value
        operators = OPERATORS_BY_FIELD[field]
        self.operator_dropdown.options = [ft.DropdownOption(key=k, text=t) for k, t in operators]
        self.operator_dropdown.value = operators[0][0]
        self.value_field.hint_text = VALUE_HINTS[field]
        self.operator_dropdown.update()
        self.value_field.update()

    def to_filter_rule(self) -> FilterRule:
        return FilterRule(
            field=self.field_dropdown.value,
            operator=self.operator_dropdown.value,
            value=self.value_field.value or "",
        )
