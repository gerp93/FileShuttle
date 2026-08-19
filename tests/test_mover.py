from pathlib import Path

from fileshuttle.engine.models import FileOutcome, MappingConfig
from fileshuttle.engine.mover import run_mapping, undo_run


def _mapping(tmp_path: Path, recursive: bool, conflict_policy: str = "skip", filters=None,
             filter_match_mode: str = "all") -> MappingConfig:
    return MappingConfig(
        id=1,
        name="test",
        source_path=str(tmp_path / "source"),
        dest_path=str(tmp_path / "dest"),
        recursive=recursive,
        conflict_policy=conflict_policy,
        filter_match_mode=filter_match_mode,
        filters=filters or [],
    )


def test_recursive_preserves_relative_structure(tmp_path):
    source = tmp_path / "source"
    (source / "sub").mkdir(parents=True)
    (source / "top.txt").write_text("top")
    (source / "sub" / "nested.txt").write_text("nested")

    result = run_mapping(_mapping(tmp_path, recursive=True))

    assert result.files_moved == 2
    assert (tmp_path / "dest" / "top.txt").exists()
    assert (tmp_path / "dest" / "sub" / "nested.txt").exists()
    assert not (source / "top.txt").exists()


def test_non_recursive_stays_top_level_only(tmp_path):
    source = tmp_path / "source"
    (source / "sub").mkdir(parents=True)
    (source / "top.txt").write_text("top")
    (source / "sub" / "nested.txt").write_text("nested")

    result = run_mapping(_mapping(tmp_path, recursive=False))

    assert result.files_moved == 1
    assert (tmp_path / "dest" / "top.txt").exists()
    assert (source / "sub" / "nested.txt").exists()  # untouched


def test_conflict_overwrite_replaces_dest(tmp_path):
    source = tmp_path / "source"
    dest = tmp_path / "dest"
    source.mkdir()
    dest.mkdir()
    (source / "file.txt").write_text("new content")
    (dest / "file.txt").write_text("old content")

    result = run_mapping(_mapping(tmp_path, recursive=False, conflict_policy="overwrite"))

    assert result.files_moved == 1
    assert (dest / "file.txt").read_text() == "new content"


def test_conflict_skip_leaves_dest_untouched(tmp_path):
    source = tmp_path / "source"
    dest = tmp_path / "dest"
    source.mkdir()
    dest.mkdir()
    (source / "file.txt").write_text("new content")
    (dest / "file.txt").write_text("old content")

    result = run_mapping(_mapping(tmp_path, recursive=False, conflict_policy="skip"))

    assert result.files_moved == 0
    assert result.files_skipped == 1
    assert result.file_outcomes[0].reason == "conflict_skip"
    assert (dest / "file.txt").read_text() == "old content"
    assert (source / "file.txt").exists()  # left in source since it wasn't moved


def test_conflict_auto_rename_does_not_touch_existing(tmp_path):
    source = tmp_path / "source"
    dest = tmp_path / "dest"
    source.mkdir()
    dest.mkdir()
    (source / "file.txt").write_text("new content")
    (dest / "file.txt").write_text("old content")

    result = run_mapping(_mapping(tmp_path, recursive=False, conflict_policy="auto_rename"))

    assert result.files_moved == 1
    assert (dest / "file.txt").read_text() == "old content"
    assert (dest / "file (1).txt").read_text() == "new content"


def test_forced_move_failure_records_error_and_continues(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    (source / "a.txt").write_text("a")
    (source / "b.txt").write_text("b")

    import fileshuttle.engine.mover as mover_module

    original_move = mover_module.shutil.move

    def flaky_move(src, dst):
        if str(src).endswith("a.txt"):
            raise OSError("simulated failure")
        return original_move(src, dst)

    monkeypatch.setattr(mover_module.shutil, "move", flaky_move)

    result = run_mapping(_mapping(tmp_path, recursive=False))

    assert result.files_errored == 1
    assert result.files_moved == 1
    assert (tmp_path / "dest" / "b.txt").exists()


def test_filters_restrict_candidates(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "keep.txt").write_text("keep")
    (source / "skip.log").write_text("skip")

    from fileshuttle.engine.models import FilterRule

    mapping = _mapping(
        tmp_path, recursive=False,
        filters=[FilterRule("extension", "equals", "txt")],
    )
    result = run_mapping(mapping)

    assert result.files_moved == 1
    assert (tmp_path / "dest" / "keep.txt").exists()
    assert (source / "skip.log").exists()


def test_any_match_mode_moves_files_matching_at_least_one_filter(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "a.txt").write_text("a")
    (source / "b.log").write_text("b" * 2000)
    (source / "c.bin").write_text("nope")

    from fileshuttle.engine.models import FilterRule

    mapping = _mapping(
        tmp_path, recursive=False, filter_match_mode="any",
        filters=[FilterRule("extension", "equals", "txt"), FilterRule("size", "min", "1000")],
    )
    result = run_mapping(mapping)

    assert result.files_moved == 2
    assert (tmp_path / "dest" / "a.txt").exists()
    assert (tmp_path / "dest" / "b.log").exists()
    assert (source / "c.bin").exists()


def test_undo_run_moves_files_back_to_recorded_source(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "a.txt").write_text("a")
    (source / "b.txt").write_text("b")

    result = run_mapping(_mapping(tmp_path, recursive=False))
    assert result.files_moved == 2

    undo_result = undo_run(result.file_outcomes)

    assert undo_result.files_moved == 2
    assert (source / "a.txt").exists()
    assert (source / "b.txt").exists()
    assert not (tmp_path / "dest" / "a.txt").exists()
    assert not (tmp_path / "dest" / "b.txt").exists()


def test_undo_run_ignores_non_moved_outcomes(tmp_path):
    outcomes = [
        FileOutcome(str(tmp_path / "a.txt"), None, "skipped", "conflict_skip", 10),
        FileOutcome(str(tmp_path / "b.txt"), None, "error", "boom", None),
    ]
    result = undo_run(outcomes)
    assert result.file_outcomes == []


def test_undo_run_errors_when_file_missing_at_recorded_destination(tmp_path):
    outcome = FileOutcome(str(tmp_path / "src" / "a.txt"), str(tmp_path / "dst" / "a.txt"), "moved", None, 10)
    result = undo_run([outcome])
    assert result.files_errored == 1
    assert result.files_moved == 0


def test_undo_run_skips_when_something_already_at_original_source(tmp_path):
    dst = tmp_path / "dst"
    src = tmp_path / "src"
    dst.mkdir()
    src.mkdir()
    (dst / "a.txt").write_text("moved content")
    (src / "a.txt").write_text("new content that appeared since")

    outcome = FileOutcome(str(src / "a.txt"), str(dst / "a.txt"), "moved", None, 10)
    result = undo_run([outcome])

    assert result.files_skipped == 1
    assert (src / "a.txt").read_text() == "new content that appeared since"
    assert (dst / "a.txt").exists()  # left in place since the undo was skipped
