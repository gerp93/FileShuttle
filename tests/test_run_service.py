import sqlite3

import pytest

from fileshuttle.db import repository as repo
from fileshuttle.db.schema import init_schema
from fileshuttle.engine.models import FilterRule
from fileshuttle.services.run_service import execute_all_enabled, execute_mapping, execute_undo


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "test.db"))
    connection.row_factory = sqlite3.Row
    init_schema(connection)
    yield connection
    connection.close()


def test_execute_mapping_moves_files_and_records_history(tmp_path, conn):
    source = tmp_path / "source"
    source.mkdir()
    (source / "keep.txt").write_text("keep")
    (source / "skip.log").write_text("skip")

    mapping_id = repo.create_mapping(
        conn, name="Text files", source_path=str(source), dest_path=str(tmp_path / "dest"),
        recursive=False, conflict_policy="skip", enabled=True, schedule_type="manual",
        schedule_interval_minutes=None, schedule_daily_time=None,
        filters=[FilterRule("extension", "equals", "txt")],
    )

    result = execute_mapping(conn, mapping_id, "manual")

    assert result.files_moved == 1
    assert (tmp_path / "dest" / "keep.txt").exists()
    assert (source / "skip.log").exists()

    runs = repo.list_runs(conn, mapping_id=mapping_id)
    assert len(runs) == 1
    assert runs[0].status == "success"
    assert runs[0].files_moved == 1


def test_execute_all_enabled_skips_disabled_mappings(tmp_path, conn):
    src_a = tmp_path / "a_src"
    src_b = tmp_path / "b_src"
    src_a.mkdir()
    src_b.mkdir()
    (src_a / "f.txt").write_text("a")
    (src_b / "f.txt").write_text("b")

    repo.create_mapping(
        conn, name="A (enabled)", source_path=str(src_a), dest_path=str(tmp_path / "a_dst"),
        recursive=False, conflict_policy="skip", enabled=True, schedule_type="manual",
        schedule_interval_minutes=None, schedule_daily_time=None, filters=[],
    )
    repo.create_mapping(
        conn, name="B (disabled)", source_path=str(src_b), dest_path=str(tmp_path / "b_dst"),
        recursive=False, conflict_policy="skip", enabled=False, schedule_type="manual",
        schedule_interval_minutes=None, schedule_daily_time=None, filters=[],
    )

    results = execute_all_enabled(conn, "manual")

    assert len(results) == 1
    assert (tmp_path / "a_dst" / "f.txt").exists()
    assert (src_b / "f.txt").exists()  # untouched, disabled mapping never ran


def test_execute_undo_moves_files_back_and_marks_original_run_undone(tmp_path, conn):
    source = tmp_path / "source"
    source.mkdir()
    (source / "keep.txt").write_text("keep")

    mapping_id = repo.create_mapping(
        conn, name="Text files", source_path=str(source), dest_path=str(tmp_path / "dest"),
        recursive=False, conflict_policy="skip", enabled=True, schedule_type="manual",
        schedule_interval_minutes=None, schedule_daily_time=None,
        filters=[FilterRule("extension", "equals", "txt")],
    )
    execute_mapping(conn, mapping_id, "manual")
    original_run = repo.list_runs(conn, mapping_id=mapping_id)[0]
    assert (tmp_path / "dest" / "keep.txt").exists()

    undo_result = execute_undo(conn, original_run.id)

    assert undo_result.files_moved == 1
    assert (source / "keep.txt").exists()
    assert not (tmp_path / "dest" / "keep.txt").exists()

    refreshed_original = repo.get_run(conn, original_run.id)
    assert refreshed_original.undone_by_run_id is not None

    undo_entry = repo.get_run(conn, refreshed_original.undone_by_run_id)
    assert undo_entry.trigger_type == "undo"
    assert undo_entry.files_moved == 1


def test_execute_undo_raises_for_unknown_run(conn):
    with pytest.raises(ValueError):
        execute_undo(conn, 999)
