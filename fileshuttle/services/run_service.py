"""The seam between persistence (`db/`) and the filesystem engine
(`engine/`). Both the scheduler's jobs and the UI's Run Now/Run All Enabled
buttons call `execute_mapping` — it's the one place that talks to both
layers, so `engine/` never has to know mappings live in SQLite.
"""
import sqlite3

from fileshuttle.db import repository as repo
from fileshuttle.engine.models import RunResult
from fileshuttle.engine.mover import run_mapping, undo_run


def execute_mapping(conn: sqlite3.Connection, mapping_id: int, trigger_type: str) -> RunResult:
    """Runs `mapping_id`, then follows its `next_mapping_id` chain (each
    hop logged as its own run_history row, linked via triggered_by_run_id)
    for as long as every mapping in the chain is one we haven't already run
    in this call — that guard is what stops an accidental A->B->A cycle
    from looping forever. Only the first mapping's own result is returned,
    matching every existing caller, which only cares about the mapping it
    asked to run."""
    record = repo.get_mapping(conn, mapping_id)
    if record is None:
        raise ValueError(f"No mapping with id {mapping_id}")

    chain_results = _run_chain(conn, mapping_id, trigger_type, visited=set())
    return chain_results[0][1]


def _run_chain(
    conn: sqlite3.Connection, mapping_id: int, trigger_type: str, visited: set[int],
) -> list[tuple[int, RunResult]]:
    results: list[tuple[int, RunResult]] = []
    current_id: int | None = mapping_id
    triggered_by_run_id: int | None = None

    while current_id is not None and current_id not in visited:
        record = repo.get_mapping(conn, current_id)
        if record is None:
            break
        visited.add(current_id)

        result = run_mapping(record.to_mapping_config())
        status = _compute_status(result)
        run_id = repo.record_run(
            conn,
            mapping_id=current_id,
            mapping_name_snapshot=record.name,
            trigger_type=trigger_type,
            result=result,
            status=status,
            triggered_by_run_id=triggered_by_run_id,
        )
        results.append((current_id, result))

        triggered_by_run_id = run_id
        current_id = record.next_mapping_id

    return results


def execute_undo(conn: sqlite3.Connection, run_id: int) -> RunResult:
    """Reverses run `run_id`: moves every file it logged as 'moved' back to
    its recorded source path (see engine.mover.undo_run — exact logged
    paths, not filters or a rescan). Logs the undo itself as a new
    run_history entry (trigger_type='undo') and flags the original run as
    undone, so it isn't offered for undo again."""
    original_run = repo.get_run(conn, run_id)
    if original_run is None:
        raise ValueError(f"No run with id {run_id}")

    file_outcomes = repo.get_run_detail(conn, run_id)
    result = undo_run(file_outcomes)
    status = _compute_status(result)

    undo_run_id = repo.record_run(
        conn,
        mapping_id=original_run.mapping_id,
        mapping_name_snapshot=f"Undo of “{_base_mapping_name(conn, original_run)}”",
        trigger_type="undo",
        result=result,
        status=status,
    )
    repo.mark_run_undone(conn, run_id, undo_run_id)
    return result


def _base_mapping_name(conn: sqlite3.Connection, run) -> str:
    """The name to credit an undo entry to. Prefers the mapping's current
    (live) name over the run's snapshot, so repeatedly undoing an undo
    doesn't nest into "Undo of "Undo of "Undo of ..."" - every undo of
    this mapping's history names the same underlying mapping."""
    record = repo.get_mapping(conn, run.mapping_id)
    if record is not None:
        return record.name
    snapshot = run.mapping_name_snapshot
    if snapshot.startswith("Undo of “") and snapshot.endswith("”"):
        return snapshot[len("Undo of “"):-1]
    return snapshot


def execute_all_enabled(conn: sqlite3.Connection, trigger_type: str) -> list[tuple[int, RunResult]]:
    """Runs every enabled mapping once. A shared `visited` set is threaded
    through each mapping's chain so that a mapping already run as another
    mapping's chain target isn't run a second time when the loop reaches it
    directly."""
    visited: set[int] = set()
    all_results: list[tuple[int, RunResult]] = []
    for record in repo.list_mappings(conn, enabled_only=True):
        if record.id in visited:
            continue
        all_results.extend(_run_chain(conn, record.id, trigger_type, visited))
    return all_results


def _compute_status(result: RunResult) -> str:
    """error: something errored and nothing moved. partial: a mix of
    moves plus errors/skips. success: otherwise (including an all-skipped
    run with no errors — skipping is an intentional policy outcome, not
    a failure)."""
    if result.files_errored and not result.files_moved:
        return "error"
    if (result.files_errored or result.files_skipped) and result.files_moved:
        return "partial"
    return "success"
