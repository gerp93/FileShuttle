"""CRUD access to the mappings/filter_rules/run_history/run_history_files/
app_settings tables. Every function takes an explicit `sqlite3.Connection`
rather than reaching for a module-level global, so this layer is trivial
to unit test against a throwaway tmp-path database.
"""
import sqlite3
from dataclasses import dataclass, field

from fileshuttle.engine.models import FileOutcome, FilterRule, MappingConfig, RunResult


@dataclass
class MappingRecord:
    id: int
    name: str
    source_path: str
    dest_path: str
    recursive: bool
    conflict_policy: str
    filter_match_mode: str
    enabled: bool
    schedule_type: str
    schedule_interval_minutes: int | None
    schedule_daily_time: str | None
    created_at: str
    updated_at: str
    filters: list[FilterRule] = field(default_factory=list)

    def to_mapping_config(self) -> MappingConfig:
        return MappingConfig(
            id=self.id,
            name=self.name,
            source_path=self.source_path,
            dest_path=self.dest_path,
            recursive=self.recursive,
            conflict_policy=self.conflict_policy,
            filter_match_mode=self.filter_match_mode,
            filters=self.filters,
        )


@dataclass
class RunSummary:
    id: int
    mapping_id: int
    mapping_name_snapshot: str
    trigger_type: str
    started_at: str
    finished_at: str
    files_moved: int
    files_skipped: int
    files_errored: int
    status: str
    error_message: str | None
    undone_by_run_id: int | None


# ---------------------------------------------------------------- mappings

def create_mapping(
    conn: sqlite3.Connection, *, name: str, source_path: str, dest_path: str,
    recursive: bool, conflict_policy: str, enabled: bool, schedule_type: str,
    schedule_interval_minutes: int | None, schedule_daily_time: str | None,
    filters: list[FilterRule], filter_match_mode: str = "all",
) -> int:
    cur = conn.execute(
        """
        INSERT INTO mappings
            (name, source_path, dest_path, recursive, conflict_policy, filter_match_mode,
             enabled, schedule_type, schedule_interval_minutes, schedule_daily_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (name, source_path, dest_path, int(recursive), conflict_policy, filter_match_mode,
         int(enabled), schedule_type, schedule_interval_minutes, schedule_daily_time),
    )
    mapping_id = cur.lastrowid
    _replace_filter_rules(conn, mapping_id, filters)
    conn.commit()
    return mapping_id


def update_mapping(
    conn: sqlite3.Connection, mapping_id: int, *, name: str, source_path: str,
    dest_path: str, recursive: bool, conflict_policy: str, enabled: bool,
    schedule_type: str, schedule_interval_minutes: int | None,
    schedule_daily_time: str | None, filters: list[FilterRule],
    filter_match_mode: str = "all",
) -> None:
    conn.execute(
        """
        UPDATE mappings SET
            name = ?, source_path = ?, dest_path = ?, recursive = ?,
            conflict_policy = ?, filter_match_mode = ?, enabled = ?, schedule_type = ?,
            schedule_interval_minutes = ?, schedule_daily_time = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
        """,
        (name, source_path, dest_path, int(recursive), conflict_policy, filter_match_mode,
         int(enabled), schedule_type, schedule_interval_minutes, schedule_daily_time, mapping_id),
    )
    _replace_filter_rules(conn, mapping_id, filters)
    conn.commit()


def delete_mapping(conn: sqlite3.Connection, mapping_id: int) -> None:
    conn.execute("DELETE FROM mappings WHERE id = ?", (mapping_id,))
    conn.commit()


def set_mapping_enabled(conn: sqlite3.Connection, mapping_id: int, enabled: bool) -> None:
    conn.execute(
        "UPDATE mappings SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        (int(enabled), mapping_id),
    )
    conn.commit()


def get_mapping(conn: sqlite3.Connection, mapping_id: int) -> MappingRecord | None:
    row = conn.execute("SELECT * FROM mappings WHERE id = ?", (mapping_id,)).fetchone()
    if row is None:
        return None
    return _row_to_record(conn, row)


def list_mappings(conn: sqlite3.Connection, enabled_only: bool = False) -> list[MappingRecord]:
    sql = "SELECT * FROM mappings"
    if enabled_only:
        sql += " WHERE enabled = 1"
    sql += " ORDER BY name COLLATE NOCASE"
    rows = conn.execute(sql).fetchall()
    return [_row_to_record(conn, row) for row in rows]


def _row_to_record(conn: sqlite3.Connection, row: sqlite3.Row) -> MappingRecord:
    filter_rows = conn.execute(
        "SELECT field, operator, value FROM filter_rules WHERE mapping_id = ? ORDER BY sort_order",
        (row["id"],),
    ).fetchall()
    filters = [FilterRule(field=r["field"], operator=r["operator"], value=r["value"]) for r in filter_rows]
    return MappingRecord(
        id=row["id"],
        name=row["name"],
        source_path=row["source_path"],
        dest_path=row["dest_path"],
        recursive=bool(row["recursive"]),
        conflict_policy=row["conflict_policy"],
        filter_match_mode=row["filter_match_mode"],
        enabled=bool(row["enabled"]),
        schedule_type=row["schedule_type"],
        schedule_interval_minutes=row["schedule_interval_minutes"],
        schedule_daily_time=row["schedule_daily_time"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        filters=filters,
    )


def _replace_filter_rules(conn: sqlite3.Connection, mapping_id: int, filters: list[FilterRule]) -> None:
    conn.execute("DELETE FROM filter_rules WHERE mapping_id = ?", (mapping_id,))
    conn.executemany(
        "INSERT INTO filter_rules (mapping_id, field, operator, value, sort_order) VALUES (?, ?, ?, ?, ?)",
        [(mapping_id, f.field, f.operator, f.value, i) for i, f in enumerate(filters)],
    )


# ------------------------------------------------------------- run history

def record_run(
    conn: sqlite3.Connection, *, mapping_id: int, mapping_name_snapshot: str,
    trigger_type: str, result: RunResult, status: str, error_message: str | None = None,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO run_history
            (mapping_id, mapping_name_snapshot, trigger_type, started_at, finished_at,
             files_moved, files_skipped, files_errored, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (mapping_id, mapping_name_snapshot, trigger_type,
         result.started_at.isoformat(), result.finished_at.isoformat(),
         result.files_moved, result.files_skipped, result.files_errored,
         status, error_message),
    )
    run_id = cur.lastrowid
    conn.executemany(
        """
        INSERT INTO run_history_files (run_id, source_path, dest_path, outcome, reason, file_size_bytes)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        [(run_id, f.source_path, f.dest_path, f.outcome, f.reason, f.size_bytes) for f in result.file_outcomes],
    )
    conn.commit()
    return run_id


def list_runs(conn: sqlite3.Connection, mapping_id: int | None = None) -> list[RunSummary]:
    sql = "SELECT * FROM run_history"
    params: tuple = ()
    if mapping_id is not None:
        sql += " WHERE mapping_id = ?"
        params = (mapping_id,)
    sql += " ORDER BY started_at DESC"
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_run_summary(r) for r in rows]


def get_run(conn: sqlite3.Connection, run_id: int) -> RunSummary | None:
    row = conn.execute("SELECT * FROM run_history WHERE id = ?", (run_id,)).fetchone()
    return _row_to_run_summary(row) if row is not None else None


def mark_run_undone(conn: sqlite3.Connection, run_id: int, undone_by_run_id: int) -> None:
    conn.execute(
        "UPDATE run_history SET undone_by_run_id = ? WHERE id = ?",
        (undone_by_run_id, run_id),
    )
    conn.commit()


def get_run_stats(conn: sqlite3.Connection, mapping_id: int) -> tuple[int, RunSummary | None]:
    """(total run count, most recent run or None) for a mapping — powers
    the "N runs · last run ..." line on its Mappings card."""
    count = conn.execute(
        "SELECT COUNT(*) c FROM run_history WHERE mapping_id = ?", (mapping_id,),
    ).fetchone()["c"]
    row = conn.execute(
        "SELECT * FROM run_history WHERE mapping_id = ? ORDER BY started_at DESC LIMIT 1",
        (mapping_id,),
    ).fetchone()
    return count, (_row_to_run_summary(row) if row is not None else None)


def _row_to_run_summary(r: sqlite3.Row) -> RunSummary:
    return RunSummary(
        id=r["id"], mapping_id=r["mapping_id"], mapping_name_snapshot=r["mapping_name_snapshot"],
        trigger_type=r["trigger_type"], started_at=r["started_at"], finished_at=r["finished_at"],
        files_moved=r["files_moved"], files_skipped=r["files_skipped"], files_errored=r["files_errored"],
        status=r["status"], error_message=r["error_message"], undone_by_run_id=r["undone_by_run_id"],
    )


def get_run_detail(conn: sqlite3.Connection, run_id: int) -> list[FileOutcome]:
    rows = conn.execute(
        "SELECT source_path, dest_path, outcome, reason, file_size_bytes FROM run_history_files WHERE run_id = ?",
        (run_id,),
    ).fetchall()
    return [
        FileOutcome(
            source_path=r["source_path"], dest_path=r["dest_path"], outcome=r["outcome"],
            reason=r["reason"], size_bytes=r["file_size_bytes"],
        )
        for r in rows
    ]


# --------------------------------------------------------------- settings

def get_setting(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row is not None else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()
