"""Data types shared across the engine. Plain dataclasses only — no Flet or
sqlite3 imports here, so this module (and everything in `engine/`) stays
usable headlessly in tests and independent of how mappings are persisted.
"""
from dataclasses import dataclass, field
from datetime import datetime

FILTER_FIELDS = (
    "extension",
    "filename_glob",
    "filename_regex",
    "size",
    "modified_date",
    "created_date",
)

FILTER_OPERATORS = ("equals", "matches", "min", "max", "before", "after")

CONFLICT_POLICIES = ("overwrite", "skip", "auto_rename")

FILTER_MATCH_MODES = ("all", "any")

ACTION_TYPES = ("move", "delete")


@dataclass
class FilterRule:
    field: str
    operator: str
    value: str


@dataclass
class MappingConfig:
    id: int
    name: str
    source_path: str
    dest_path: str
    recursive: bool
    conflict_policy: str
    filter_match_mode: str = "all"  # 'all' (AND, every filter must match) or 'any' (OR)
    filters: list[FilterRule] = field(default_factory=list)
    action_type: str = "move"  # 'move' (to dest_path) or 'delete' (send to Recycle Bin)


@dataclass
class FileOutcome:
    source_path: str
    dest_path: str | None
    outcome: str  # 'moved' | 'deleted' | 'skipped' | 'error'
    reason: str | None
    size_bytes: int | None


@dataclass
class RunResult:
    started_at: datetime
    finished_at: datetime
    file_outcomes: list[FileOutcome] = field(default_factory=list)

    @property
    def files_moved(self) -> int:
        return sum(1 for f in self.file_outcomes if f.outcome == "moved")

    @property
    def files_deleted(self) -> int:
        return sum(1 for f in self.file_outcomes if f.outcome == "deleted")

    @property
    def files_skipped(self) -> int:
        return sum(1 for f in self.file_outcomes if f.outcome == "skipped")

    @property
    def files_errored(self) -> int:
        return sum(1 for f in self.file_outcomes if f.outcome == "error")
