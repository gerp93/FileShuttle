"""Filter evaluation: given a file and a mapping's filter rules, decide
whether the file is a move candidate. Rules on a mapping are combined
either as AND ('all' — every rule must pass) or OR ('any' — one rule
passing is enough), per the mapping's filter_match_mode. An empty rule
list matches everything regardless of mode.
"""
import fnmatch
import os
import re
from datetime import datetime
from pathlib import Path

from .models import FilterRule


def evaluate_filters(
    file_path: Path, stat_info: os.stat_result, filters: list[FilterRule], match_mode: str = "all",
) -> bool:
    if not filters:
        return True
    results = (matches_filter(file_path, stat_info, rule) for rule in filters)
    if match_mode == "any":
        return any(results)
    return all(results)


def matches_filter(file_path: Path, stat_info: os.stat_result, rule: FilterRule) -> bool:
    if rule.field == "extension":
        return _match_extension(file_path, rule.value)
    if rule.field == "filename_glob":
        return fnmatch.fnmatch(file_path.name.lower(), rule.value.lower())
    if rule.field == "filename_regex":
        return re.search(rule.value, file_path.name) is not None
    if rule.field == "size":
        return _match_size(stat_info.st_size, rule.operator, rule.value)
    if rule.field == "modified_date":
        return _match_date(stat_info.st_mtime, rule.operator, rule.value)
    if rule.field == "created_date":
        # True creation time on Windows; inode-change time on POSIX (no
        # portable creation time exists there) — a known platform caveat,
        # not something this function can paper over.
        return _match_date(stat_info.st_ctime, rule.operator, rule.value)
    raise ValueError(f"Unknown filter field: {rule.field!r}")


def _match_extension(file_path: Path, value: str) -> bool:
    wanted = value.lower().lstrip(".")
    return file_path.suffix.lower().lstrip(".") == wanted


def _match_size(actual_bytes: int, operator: str, value: str) -> bool:
    threshold = int(value)
    if operator == "min":
        return actual_bytes >= threshold
    if operator == "max":
        return actual_bytes <= threshold
    raise ValueError(f"Unknown size operator: {operator!r}")


def _match_date(actual_timestamp: float, operator: str, value: str) -> bool:
    threshold = datetime.fromisoformat(value)
    actual = datetime.fromtimestamp(actual_timestamp)
    if operator == "before":
        return actual < threshold
    if operator == "after":
        return actual > threshold
    raise ValueError(f"Unknown date operator: {operator!r}")
