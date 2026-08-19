"""The move engine: walks a mapping's source folder, filters candidates,
and moves matches to the destination. Pure filesystem logic — no DB or
Flet imports. `services/run_service.py` is the only caller, and is what
connects this to persistence.
"""
import shutil
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

from .filters import evaluate_filters
from .models import FileOutcome, MappingConfig, RunResult


def run_mapping(mapping: MappingConfig) -> RunResult:
    started_at = datetime.now()
    source_root = Path(mapping.source_path)
    dest_root = Path(mapping.dest_path)
    outcomes: list[FileOutcome] = []

    for file_path in iter_candidate_files(source_root, mapping.recursive):
        try:
            stat_info = file_path.stat()
        except OSError as exc:
            outcomes.append(FileOutcome(str(file_path), None, "error", str(exc), None))
            continue

        if not evaluate_filters(file_path, stat_info, mapping.filters, mapping.filter_match_mode):
            continue

        dest_path = resolve_destination(source_root, dest_root, file_path)
        reason = None
        if dest_path.exists():
            resolved = resolve_conflict(dest_path, mapping.conflict_policy)
            if resolved is None:
                outcomes.append(FileOutcome(
                    str(file_path), None, "skipped",
                    f"conflict_{mapping.conflict_policy}", stat_info.st_size,
                ))
                continue
            dest_path = resolved
            reason = f"conflict_{mapping.conflict_policy}"

        try:
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(file_path), str(dest_path))
            outcomes.append(FileOutcome(str(file_path), str(dest_path), "moved", reason, stat_info.st_size))
        except Exception as exc:
            outcomes.append(FileOutcome(str(file_path), str(dest_path), "error", str(exc), stat_info.st_size))

    finished_at = datetime.now()
    return RunResult(started_at=started_at, finished_at=finished_at, file_outcomes=outcomes)


def undo_run(file_outcomes: list[FileOutcome]) -> RunResult:
    """Reverses a completed run: for every 'moved' outcome, moves the file
    back from its recorded dest_path to its recorded source_path — using
    exactly those logged paths, not filters or a fresh directory scan.
    Outcomes other than 'moved' (skipped/errored originally) are ignored,
    since nothing actually moved for those. A file already sitting back at
    the original source path is left alone (recorded as skipped) rather
    than silently overwritten, in case something new landed there since."""
    started_at = datetime.now()
    outcomes: list[FileOutcome] = []

    for original in file_outcomes:
        if original.outcome != "moved" or not original.dest_path:
            continue

        current_path = Path(original.dest_path)
        original_path = Path(original.source_path)

        if not current_path.exists():
            outcomes.append(FileOutcome(
                original.dest_path, original.source_path, "error",
                "file no longer exists at its recorded destination", None,
            ))
            continue

        if original_path.exists():
            outcomes.append(FileOutcome(
                original.dest_path, None, "skipped",
                "a file already exists at the original source path", None,
            ))
            continue

        try:
            original_path.parent.mkdir(parents=True, exist_ok=True)
            size = current_path.stat().st_size
            shutil.move(str(current_path), str(original_path))
            outcomes.append(FileOutcome(original.dest_path, original.source_path, "moved", None, size))
        except Exception as exc:
            outcomes.append(FileOutcome(original.dest_path, original.source_path, "error", str(exc), None))

    finished_at = datetime.now()
    return RunResult(started_at=started_at, finished_at=finished_at, file_outcomes=outcomes)


def iter_candidate_files(source: Path, recursive: bool) -> Iterator[Path]:
    if recursive:
        yield from (p for p in source.rglob("*") if p.is_file())
    else:
        yield from (p for p in source.iterdir() if p.is_file())


def resolve_destination(source_root: Path, dest_root: Path, file_path: Path) -> Path:
    """dest_root joined with the file's path relative to source_root — this
    is what preserves subfolder structure when recursive=True."""
    return dest_root / file_path.relative_to(source_root)


def resolve_conflict(dest_path: Path, policy: str) -> Path | None:
    """Called only when dest_path already exists. Returns the final
    destination path to move to, or None to signal the caller should
    record a skipped outcome and leave the existing file untouched."""
    if policy == "overwrite":
        return dest_path
    if policy == "skip":
        return None
    if policy == "auto_rename":
        return _first_free_path(dest_path)
    raise ValueError(f"Unknown conflict policy: {policy!r}")


def _first_free_path(dest_path: Path) -> Path:
    stem, suffix, parent = dest_path.stem, dest_path.suffix, dest_path.parent
    n = 1
    while True:
        candidate = parent / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
        n += 1
