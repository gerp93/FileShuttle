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
        action_type                 TEXT NOT NULL DEFAULT 'move'
                                     CHECK (action_type IN ('move','copy','delete')),
        conflict_policy             TEXT NOT NULL DEFAULT 'skip'
                                     CHECK (conflict_policy IN ('overwrite','skip','auto_rename')),
        filter_match_mode           TEXT NOT NULL DEFAULT 'all'
                                     CHECK (filter_match_mode IN ('all','any')),
        enabled                     INTEGER NOT NULL DEFAULT 1,
        schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                     CHECK (schedule_type IN ('manual','interval','daily_at')),
        schedule_interval_minutes   INTEGER,
        schedule_daily_time         TEXT,
        next_mapping_id             INTEGER REFERENCES mappings(id) ON DELETE SET NULL,
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
        files_copied            INTEGER NOT NULL DEFAULT 0,
        files_deleted           INTEGER NOT NULL DEFAULT 0,
        files_skipped          INTEGER NOT NULL DEFAULT 0,
        files_errored          INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL CHECK (status IN ('success','partial','error')),
        error_message          TEXT,
        undone_by_run_id       INTEGER REFERENCES run_history(id) ON DELETE SET NULL,
        triggered_by_run_id    INTEGER REFERENCES run_history(id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS run_history_files (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
        source_path     TEXT NOT NULL,
        dest_path       TEXT,
        outcome         TEXT NOT NULL CHECK (outcome IN ('moved','copied','deleted','skipped','error')),
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


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    """Migrates a pre-existing database (from before `column` was added to
    `table`'s CREATE statement above) by hand, since `CREATE TABLE IF NOT
    EXISTS` only affects brand-new databases."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _widen_run_history_files_outcome_check(conn: sqlite3.Connection) -> None:
    """Pre-existing DBs have a run_history_files.outcome CHECK constraint
    that doesn't allow 'deleted' and/or 'copied' (added for the recycle-bin
    and copy action types). SQLite can't ALTER a CHECK constraint in place,
    so rebuild the table when an old-shaped one is found, preserving its
    data. run_history_files has no children, so a plain rename-out-of-the-
    way is safe here (nothing else references it by name)."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='run_history_files'"
    ).fetchone()
    if row is None or "'copied'" in row[0]:
        return
    conn.execute("ALTER TABLE run_history_files RENAME TO run_history_files_old")
    conn.execute("""
        CREATE TABLE run_history_files (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id          INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
            source_path     TEXT NOT NULL,
            dest_path       TEXT,
            outcome         TEXT NOT NULL CHECK (outcome IN ('moved','copied','deleted','skipped','error')),
            reason          TEXT,
            file_size_bytes INTEGER
        )
    """)
    conn.execute(
        "INSERT INTO run_history_files (id, run_id, source_path, dest_path, outcome, reason, file_size_bytes) "
        "SELECT id, run_id, source_path, dest_path, outcome, reason, file_size_bytes FROM run_history_files_old"
    )
    conn.execute("DROP TABLE run_history_files_old")


def _widen_mappings_action_type_check(conn: sqlite3.Connection) -> None:
    """Pre-existing DBs have a mappings.action_type CHECK constraint that
    doesn't allow 'copy' (added alongside the copy action type). Unlike
    run_history_files above, mappings is a parent table — filter_rules and
    run_history reference it by name, and it self-references via
    next_mapping_id — so it can't just be renamed out of the way (SQLite
    auto-patches other tables' foreign key clauses to follow a renamed
    table, which would leave those clauses pointing at a table we're about
    to drop). Instead: build the replacement under a temporary name, copy
    the data across, drop the old table, then rename the replacement into
    place — the child tables' FK clauses (which still say 'mappings' the
    whole time) end up resolving correctly without ever being touched."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='mappings'"
    ).fetchone()
    if row is None or "'copy'" in row[0]:
        return
    # A prior statement (e.g. the run_history_files migration above) may have
    # left an implicit transaction open, which would silently no-op the
    # PRAGMA below and leave foreign keys enforced — and with foreign_keys
    # ON, DROP TABLE fires ON DELETE CASCADE against every referencing row
    # as if the table's rows had all been deleted first, wiping out
    # filter_rules/run_history along with it. Commit first so the toggle
    # actually takes effect.
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("""
        CREATE TABLE mappings_new (
            id                          INTEGER PRIMARY KEY AUTOINCREMENT,
            name                        TEXT NOT NULL,
            source_path                 TEXT NOT NULL,
            dest_path                   TEXT NOT NULL,
            recursive                   INTEGER NOT NULL DEFAULT 0,
            action_type                 TEXT NOT NULL DEFAULT 'move'
                                         CHECK (action_type IN ('move','copy','delete')),
            conflict_policy             TEXT NOT NULL DEFAULT 'skip'
                                         CHECK (conflict_policy IN ('overwrite','skip','auto_rename')),
            filter_match_mode           TEXT NOT NULL DEFAULT 'all'
                                         CHECK (filter_match_mode IN ('all','any')),
            enabled                     INTEGER NOT NULL DEFAULT 1,
            schedule_type               TEXT NOT NULL DEFAULT 'manual'
                                         CHECK (schedule_type IN ('manual','interval','daily_at')),
            schedule_interval_minutes   INTEGER,
            schedule_daily_time         TEXT,
            next_mapping_id             INTEGER REFERENCES mappings_new(id) ON DELETE SET NULL,
            created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
    """)
    conn.execute("""
        INSERT INTO mappings_new
            (id, name, source_path, dest_path, recursive, action_type, conflict_policy,
             filter_match_mode, enabled, schedule_type, schedule_interval_minutes,
             schedule_daily_time, next_mapping_id, created_at, updated_at)
        SELECT
            id, name, source_path, dest_path, recursive, action_type, conflict_policy,
            filter_match_mode, enabled, schedule_type, schedule_interval_minutes,
            schedule_daily_time, next_mapping_id, created_at, updated_at
        FROM mappings
    """)
    conn.execute("DROP TABLE mappings")
    conn.execute("ALTER TABLE mappings_new RENAME TO mappings")
    # Foreign key enforcement can't be re-enabled mid-transaction (it silently
    # no-ops), so commit the rebuild first, then flip it back on afterwards.
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def init_schema(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    for statement in _STATEMENTS:
        conn.execute(statement)
    _add_column_if_missing(conn, "mappings", "next_mapping_id",
                            "next_mapping_id INTEGER REFERENCES mappings(id) ON DELETE SET NULL")
    _add_column_if_missing(conn, "mappings", "action_type",
                            "action_type TEXT NOT NULL DEFAULT 'move' CHECK (action_type IN ('move','copy','delete'))")
    _add_column_if_missing(conn, "run_history", "triggered_by_run_id",
                            "triggered_by_run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL")
    _add_column_if_missing(conn, "run_history", "files_deleted",
                            "files_deleted INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "run_history", "files_copied",
                            "files_copied INTEGER NOT NULL DEFAULT 0")
    _widen_run_history_files_outcome_check(conn)
    _widen_mappings_action_type_check(conn)
    conn.commit()
