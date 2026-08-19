"""SQLite schema for FileShuttle. All statements are idempotent
(`IF NOT EXISTS`) so `init_schema` can be called unconditionally on every
app startup, including right after a database relocation."""
import sqlite3

_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS mappings (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        name                        TEXT NOT NULL,
        source_path                 TEXT NOT NULL,
        dest_path                   TEXT NOT NULL,
        recursive                   INTEGER NOT NULL DEFAULT 0,
        conflict_policy             TEXT NOT NULL DEFAULT 'skip'
                                     CHECK (conflict_policy IN ('overwrite','skip','auto_rename')),
        filter_match_mode           TEXT NOT NULL DEFAULT 'all'
                                     CHECK (filter_match_mode IN ('all','any')),
        enabled                     INTEGER NOT NULL DEFAULT 1,
        schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                     CHECK (schedule_type IN ('manual','interval','daily_at')),
        schedule_interval_minutes   INTEGER,
        schedule_daily_time         TEXT,
        created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS filter_rules (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        mapping_id   INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
        field        TEXT NOT NULL CHECK (field IN
                     ('extension','filename_glob','filename_regex','size','modified_date','created_date')),
        operator     TEXT NOT NULL CHECK (operator IN ('equals','matches','min','max','before','after')),
        value        TEXT NOT NULL,
        sort_order   INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS run_history (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        mapping_id             INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
        mapping_name_snapshot  TEXT NOT NULL,
        trigger_type           TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo')),
        started_at             TEXT NOT NULL,
        finished_at            TEXT NOT NULL,
        files_moved            INTEGER NOT NULL DEFAULT 0,
        files_skipped          INTEGER NOT NULL DEFAULT 0,
        files_errored          INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL CHECK (status IN ('success','partial','error')),
        error_message          TEXT,
        undone_by_run_id       INTEGER REFERENCES run_history(id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS run_history_files (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
        source_path     TEXT NOT NULL,
        dest_path       TEXT,
        outcome         TEXT NOT NULL CHECK (outcome IN ('moved','skipped','error')),
        reason          TEXT,
        file_size_bytes INTEGER
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS app_settings (
        key    TEXT PRIMARY KEY,
        value  TEXT
    )
    """,
)


def init_schema(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    for statement in _STATEMENTS:
        conn.execute(statement)
    conn.commit()
