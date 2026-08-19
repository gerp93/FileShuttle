"""Shared context passed to every view builder: the DB connection, the
scheduler, and callbacks to switch what's shown in the content area. Views
rebuild themselves from the database on every navigation rather than
holding onto mutable UI state, which keeps each view function simple and
always in sync with the DB.
"""
import sqlite3
from dataclasses import dataclass
from typing import Callable

import flet as ft

from fileshuttle.scheduler.scheduler import SchedulerService


@dataclass
class AppState:
    page: ft.Page
    conn: sqlite3.Connection
    scheduler: SchedulerService
    show_mappings: Callable[[], None]
    show_history: Callable[[], None]
    show_settings: Callable[[], None]
    show_mapping_editor: Callable[[int | None], None]
