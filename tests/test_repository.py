import sqlite3

import pytest

from fileshuttle.db import repository as repo
from fileshuttle.db.schema import init_schema
from fileshuttle.engine.models import FilterRule, FileOutcome, RunResult
from datetime import datetime


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    connection = sqlite3.connect(str(path))
    connection.row_factory = sqlite3.Row
    init_schema(connection)
    yield connection
    connection.close()


def _create_sample_mapping(conn, **overrides):
    defaults = dict(
        name="Downloads to Archive",
        source_path="C:/src",
        dest_path="C:/dst",
        recursive=True,
        conflict_policy="skip",
        enabled=True,
        schedule_type="interval",
        schedule_interval_minutes=30,
        schedule_daily_time=None,
        filters=[FilterRule("extension", "equals", "pdf")],
    )
    defaults.update(overrides)
    return repo.create_mapping(conn, **defaults)


def test_create_and_get_mapping_roundtrip(conn):
    mapping_id = _create_sample_mapping(conn)
    record = repo.get_mapping(conn, mapping_id)

    assert record is not None
    assert record.name == "Downloads to Archive"
    assert record.recursive is True
    assert record.schedule_interval_minutes == 30
    assert len(record.filters) == 1
    assert record.filters[0].field == "extension"


def test_filter_match_mode_defaults_to_all_and_round_trips_any(conn):
    default_id = _create_sample_mapping(conn)
    assert repo.get_mapping(conn, default_id).filter_match_mode == "all"

    any_id = _create_sample_mapping(conn, filter_match_mode="any")
    assert repo.get_mapping(conn, any_id).filter_match_mode == "any"


def test_update_mapping_replaces_filters(conn):
    mapping_id = _create_sample_mapping(conn)
    repo.update_mapping(
        conn, mapping_id,
        name="Renamed", source_path="C:/src", dest_path="C:/dst2",
        recursive=False, conflict_policy="overwrite", enabled=False,
        schedule_type="manual", schedule_interval_minutes=None, schedule_daily_time=None,
        filters=[FilterRule("size", "min", "1024"), FilterRule("size", "max", "2048")],
    )
    record = repo.get_mapping(conn, mapping_id)

    assert record.name == "Renamed"
    assert record.enabled is False
    assert len(record.filters) == 2


def test_delete_mapping_cascades_filter_rules(conn):
    conn.execute("PRAGMA foreign_keys = ON")
    mapping_id = _create_sample_mapping(conn)

    repo.delete_mapping(conn, mapping_id)

    assert repo.get_mapping(conn, mapping_id) is None
    remaining = conn.execute("SELECT COUNT(*) c FROM filter_rules WHERE mapping_id = ?", (mapping_id,)).fetchone()
    assert remaining["c"] == 0


def test_list_mappings_enabled_only(conn):
    _create_sample_mapping(conn, name="Enabled One", enabled=True)
    _create_sample_mapping(conn, name="Disabled One", enabled=False)

    all_mappings = repo.list_mappings(conn)
    enabled_mappings = repo.list_mappings(conn, enabled_only=True)

    assert len(all_mappings) == 2
    assert len(enabled_mappings) == 1
    assert enabled_mappings[0].name == "Enabled One"


def test_record_run_and_list_and_detail(conn):
    mapping_id = _create_sample_mapping(conn)
    result = RunResult(
        started_at=datetime(2026, 1, 1, 10, 0, 0),
        finished_at=datetime(2026, 1, 1, 10, 0, 5),
        file_outcomes=[
            FileOutcome("C:/src/a.pdf", "C:/dst/a.pdf", "moved", None, 100),
            FileOutcome("C:/src/b.pdf", None, "skipped", "conflict_skip", 50),
        ],
    )
    run_id = repo.record_run(
        conn, mapping_id=mapping_id, mapping_name_snapshot="Downloads to Archive",
        trigger_type="manual", result=result, status="partial",
    )

    runs = repo.list_runs(conn)
    assert len(runs) == 1
    assert runs[0].id == run_id
    assert runs[0].files_moved == 1
    assert runs[0].files_skipped == 1

    detail = repo.get_run_detail(conn, run_id)
    assert len(detail) == 2
    assert {d.outcome for d in detail} == {"moved", "skipped"}

    assert repo.get_run(conn, run_id).id == run_id
    assert repo.get_run(conn, 999) is None


def test_mark_run_undone(conn):
    mapping_id = _create_sample_mapping(conn)
    result = RunResult(started_at=datetime.now(), finished_at=datetime.now(), file_outcomes=[])
    original_id = repo.record_run(
        conn, mapping_id=mapping_id, mapping_name_snapshot="x",
        trigger_type="manual", result=result, status="success",
    )
    assert repo.get_run(conn, original_id).undone_by_run_id is None

    undo_id = repo.record_run(
        conn, mapping_id=mapping_id, mapping_name_snapshot="Undo of x",
        trigger_type="undo", result=result, status="success",
    )
    repo.mark_run_undone(conn, original_id, undo_id)

    assert repo.get_run(conn, original_id).undone_by_run_id == undo_id


def test_get_run_stats(conn):
    mapping_id = _create_sample_mapping(conn)

    assert repo.get_run_stats(conn, mapping_id) == (0, None)

    older = RunResult(started_at=datetime(2026, 1, 1), finished_at=datetime(2026, 1, 1), file_outcomes=[])
    newer = RunResult(started_at=datetime(2026, 1, 2), finished_at=datetime(2026, 1, 2), file_outcomes=[])
    repo.record_run(conn, mapping_id=mapping_id, mapping_name_snapshot="x",
                     trigger_type="manual", result=older, status="success")
    newer_id = repo.record_run(conn, mapping_id=mapping_id, mapping_name_snapshot="x",
                                trigger_type="manual", result=newer, status="success")

    count, last_run = repo.get_run_stats(conn, mapping_id)
    assert count == 2
    assert last_run.id == newer_id


def test_run_history_cascades_on_mapping_delete(conn):
    conn.execute("PRAGMA foreign_keys = ON")
    mapping_id = _create_sample_mapping(conn)
    result = RunResult(started_at=datetime.now(), finished_at=datetime.now(), file_outcomes=[])
    repo.record_run(
        conn, mapping_id=mapping_id, mapping_name_snapshot="x",
        trigger_type="manual", result=result, status="success",
    )

    repo.delete_mapping(conn, mapping_id)

    assert repo.list_runs(conn) == []


def test_next_mapping_id_round_trips_and_nulls_on_target_delete(conn):
    conn.execute("PRAGMA foreign_keys = ON")
    target_id = _create_sample_mapping(conn, name="Target")
    chained_id = _create_sample_mapping(conn, name="Chained", next_mapping_id=target_id)

    assert repo.get_mapping(conn, chained_id).next_mapping_id == target_id

    repo.delete_mapping(conn, target_id)

    assert repo.get_mapping(conn, chained_id).next_mapping_id is None


def test_app_settings_get_set(conn):
    assert repo.get_setting(conn, "theme", default="hacker") == "hacker"
    repo.set_setting(conn, "theme", "retrowave")
    assert repo.get_setting(conn, "theme") == "retrowave"
    repo.set_setting(conn, "theme", "blue_oval")
    assert repo.get_setting(conn, "theme") == "blue_oval"
