from fileshuttle.db.repository import RunSummary
from fileshuttle.ui.views.history_view import _run_action_summary


def _run(**kwargs) -> RunSummary:
    defaults = dict(
        id=1, mapping_id=1, mapping_name_snapshot="Test", trigger_type="scheduled",
        started_at="2026-01-01T00:00:00", finished_at="2026-01-01T00:00:01",
        files_moved=0, files_copied=0, files_deleted=0, files_skipped=0, files_errored=0,
        status="success", error_message=None, undone_by_run_id=None, triggered_by_run_id=None,
    )
    defaults.update(kwargs)
    return RunSummary(**defaults)


def test_empty_delete_run_shows_deleted_not_moved():
    run = _run(files_deleted=0)
    assert _run_action_summary(run, "delete") == "deleted 0"


def test_empty_copy_run_shows_copied_not_moved():
    run = _run(files_copied=0)
    assert _run_action_summary(run, "copy") == "copied 0"


def test_deleted_mapping_falls_back_to_counts():
    run = _run(files_deleted=3)
    assert _run_action_summary(run, None) == "deleted 3"
