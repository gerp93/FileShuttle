import sqlite3

import pytest

from fileshuttle.db.schema import init_schema


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "test.db"))
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


def test_init_schema_is_idempotent(conn):
    init_schema(conn)
    init_schema(conn)  # must not raise on a second run against an up-to-date db


def test_init_schema_migrates_pre_chaining_database(conn):
    """Simulates an existing user's database created before next_mapping_id/
    triggered_by_run_id existed: hand-creates the old-shaped tables, then
    checks init_schema adds the new columns via ALTER TABLE without
    dropping any existing data."""
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("""
        CREATE TABLE mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            dest_path TEXT NOT NULL,
            recursive INTEGER NOT NULL DEFAULT 0,
            conflict_policy TEXT NOT NULL DEFAULT 'skip',
            filter_match_mode TEXT NOT NULL DEFAULT 'all',
            enabled INTEGER NOT NULL DEFAULT 1,
            schedule_type TEXT NOT NULL DEFAULT 'manual',
            schedule_interval_minutes INTEGER,
            schedule_daily_time TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
    """)
    conn.execute("""
        CREATE TABLE run_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mapping_id INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
            mapping_name_snapshot TEXT NOT NULL,
            trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo')),
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            files_moved INTEGER NOT NULL DEFAULT 0,
            files_skipped INTEGER NOT NULL DEFAULT 0,
            files_errored INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK (status IN ('success','partial','error')),
            error_message TEXT,
            undone_by_run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL
        )
    """)
    conn.execute(
        "INSERT INTO mappings (id, name, source_path, dest_path) VALUES (1, 'Old', 'C:/s', 'C:/d')"
    )
    conn.execute(
        "INSERT INTO run_history (id, mapping_id, mapping_name_snapshot, trigger_type, "
        "started_at, finished_at, status) VALUES (1, 1, 'Old', 'manual', 't0', 't1', 'success')"
    )
    conn.commit()

    init_schema(conn)

    mapping_cols = {row[1] for row in conn.execute("PRAGMA table_info(mappings)")}
    run_history_cols = {row[1] for row in conn.execute("PRAGMA table_info(run_history)")}
    assert "next_mapping_id" in mapping_cols
    assert "triggered_by_run_id" in run_history_cols

    row = conn.execute("SELECT * FROM mappings WHERE id = 1").fetchone()
    assert row["name"] == "Old"
    assert row["next_mapping_id"] is None

    run_row = conn.execute("SELECT * FROM run_history WHERE id = 1").fetchone()
    assert run_row["mapping_name_snapshot"] == "Old"
    assert run_row["triggered_by_run_id"] is None


def test_init_schema_migrates_pre_delete_action_database(conn):
    """Simulates an existing user's database created before the delete/
    recycle-bin action type existed: hand-creates the old-shaped tables
    (no mappings.action_type, no run_history.files_deleted, and a
    run_history_files.outcome CHECK that rejects 'deleted'), then checks
    init_schema migrates it in place, preserving existing rows, and that
    the widened CHECK constraint actually accepts 'deleted' afterwards."""
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("""
        CREATE TABLE mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            dest_path TEXT NOT NULL,
            recursive INTEGER NOT NULL DEFAULT 0,
            conflict_policy TEXT NOT NULL DEFAULT 'skip',
            filter_match_mode TEXT NOT NULL DEFAULT 'all',
            enabled INTEGER NOT NULL DEFAULT 1,
            schedule_type TEXT NOT NULL DEFAULT 'manual',
            schedule_interval_minutes INTEGER,
            schedule_daily_time TEXT,
            next_mapping_id INTEGER REFERENCES mappings(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
    """)
    conn.execute("""
        CREATE TABLE run_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mapping_id INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
            mapping_name_snapshot TEXT NOT NULL,
            trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo')),
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            files_moved INTEGER NOT NULL DEFAULT 0,
            files_skipped INTEGER NOT NULL DEFAULT 0,
            files_errored INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK (status IN ('success','partial','error')),
            error_message TEXT,
            undone_by_run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL,
            triggered_by_run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL
        )
    """)
    conn.execute("""
        CREATE TABLE run_history_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
            source_path TEXT NOT NULL,
            dest_path TEXT,
            outcome TEXT NOT NULL CHECK (outcome IN ('moved','skipped','error')),
            reason TEXT,
            file_size_bytes INTEGER
        )
    """)
    conn.execute(
        "INSERT INTO mappings (id, name, source_path, dest_path) VALUES (1, 'Old', 'C:/s', 'C:/d')"
    )
    conn.execute(
        "INSERT INTO run_history (id, mapping_id, mapping_name_snapshot, trigger_type, "
        "started_at, finished_at, status) VALUES (1, 1, 'Old', 'manual', 't0', 't1', 'success')"
    )
    conn.execute(
        "INSERT INTO run_history_files (run_id, source_path, dest_path, outcome, file_size_bytes) "
        "VALUES (1, 'C:/s/a.txt', 'C:/d/a.txt', 'moved', 10)"
    )
    conn.commit()

    init_schema(conn)

    mapping_cols = {row[1] for row in conn.execute("PRAGMA table_info(mappings)")}
    run_history_cols = {row[1] for row in conn.execute("PRAGMA table_info(run_history)")}
    assert "action_type" in mapping_cols
    assert "files_deleted" in run_history_cols

    row = conn.execute("SELECT * FROM mappings WHERE id = 1").fetchone()
    assert row["name"] == "Old"
    assert row["action_type"] == "move"

    preserved = conn.execute("SELECT * FROM run_history_files WHERE run_id = 1").fetchone()
    assert preserved["source_path"] == "C:/s/a.txt"
    assert preserved["outcome"] == "moved"

    # the widened CHECK constraint must now accept 'deleted'
    conn.execute(
        "INSERT INTO run_history_files (run_id, source_path, outcome) VALUES (1, 'C:/s/b.txt', 'deleted')"
    )
    conn.commit()


def test_init_schema_migrates_pre_copy_action_database(conn):
    """Simulates an existing user's database created before the copy action
    type existed: hand-creates mappings with an action_type CHECK that only
    allows 'move'/'delete', and a run_history without files_copied. mappings
    has children (filter_rules, run_history) and a self-reference
    (next_mapping_id), unlike the run_history_files migration above, so this
    exercises the rebuild-under-a-new-name path and checks FK enforcement
    (cascade delete, self-referencing SET NULL) still works afterwards."""
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("""
        CREATE TABLE mappings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            source_path TEXT NOT NULL,
            dest_path TEXT NOT NULL,
            recursive INTEGER NOT NULL DEFAULT 0,
            action_type TEXT NOT NULL DEFAULT 'move' CHECK (action_type IN ('move','delete')),
            conflict_policy TEXT NOT NULL DEFAULT 'skip',
            filter_match_mode TEXT NOT NULL DEFAULT 'all',
            enabled INTEGER NOT NULL DEFAULT 1,
            schedule_type TEXT NOT NULL DEFAULT 'manual',
            schedule_interval_minutes INTEGER,
            schedule_daily_time TEXT,
            next_mapping_id INTEGER REFERENCES mappings(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
    """)
    conn.execute("""
        CREATE TABLE filter_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mapping_id INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
            field TEXT NOT NULL,
            operator TEXT NOT NULL,
            value TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE run_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mapping_id INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
            mapping_name_snapshot TEXT NOT NULL,
            trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','undo')),
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            files_moved INTEGER NOT NULL DEFAULT 0,
            files_deleted INTEGER NOT NULL DEFAULT 0,
            files_skipped INTEGER NOT NULL DEFAULT 0,
            files_errored INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK (status IN ('success','partial','error')),
            error_message TEXT,
            undone_by_run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL,
            triggered_by_run_id INTEGER REFERENCES run_history(id) ON DELETE SET NULL
        )
    """)
    conn.execute("""
        CREATE TABLE run_history_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL REFERENCES run_history(id) ON DELETE CASCADE,
            source_path TEXT NOT NULL,
            dest_path TEXT,
            outcome TEXT NOT NULL CHECK (outcome IN ('moved','deleted','skipped','error')),
            reason TEXT,
            file_size_bytes INTEGER
        )
    """)
    conn.execute(
        "INSERT INTO mappings (id, name, source_path, dest_path, action_type) "
        "VALUES (1, 'Target', 'C:/s', 'C:/d', 'move')"
    )
    conn.execute(
        "INSERT INTO mappings (id, name, source_path, dest_path, action_type, next_mapping_id) "
        "VALUES (2, 'Chained', 'C:/s2', 'C:/d2', 'delete', 1)"
    )
    conn.execute("INSERT INTO filter_rules (mapping_id, field, operator, value) VALUES (1, 'extension', 'equals', 'pdf')")
    conn.execute(
        "INSERT INTO run_history (id, mapping_id, mapping_name_snapshot, trigger_type, "
        "started_at, finished_at, status) VALUES (1, 1, 'Target', 'manual', 't0', 't1', 'success')"
    )
    conn.commit()

    init_schema(conn)

    mapping_cols = {row[1] for row in conn.execute("PRAGMA table_info(mappings)")}
    run_history_cols = {row[1] for row in conn.execute("PRAGMA table_info(run_history)")}
    assert "files_copied" in run_history_cols

    # pre-existing rows and relationships survive the rebuild
    row = conn.execute("SELECT * FROM mappings WHERE id = 1").fetchone()
    assert row["name"] == "Target"
    chained = conn.execute("SELECT * FROM mappings WHERE id = 2").fetchone()
    assert chained["next_mapping_id"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM filter_rules WHERE mapping_id = 1").fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM run_history WHERE mapping_id = 1").fetchone()["c"] == 1

    # the widened CHECK constraint must now accept 'copy'
    conn.execute(
        "INSERT INTO mappings (id, name, source_path, dest_path, action_type) "
        "VALUES (3, 'Copier', 'C:/s3', 'C:/d3', 'copy')"
    )
    conn.commit()
    assert "action_type" in mapping_cols

    # foreign key enforcement (cascade + self-referencing SET NULL) must still work post-rebuild
    conn.execute("DELETE FROM mappings WHERE id = 1")
    conn.commit()
    assert conn.execute("SELECT COUNT(*) c FROM filter_rules WHERE mapping_id = 1").fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM run_history WHERE mapping_id = 1").fetchone()["c"] == 0
    assert conn.execute("SELECT next_mapping_id FROM mappings WHERE id = 2").fetchone()["next_mapping_id"] is None
