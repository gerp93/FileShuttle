import os
import time
from pathlib import Path

import pytest

from fileshuttle.engine.filters import evaluate_filters, matches_filter
from fileshuttle.engine.models import FilterRule


def _stat(tmp_path: Path, name: str, content: bytes = b"") -> tuple[Path, os.stat_result]:
    p = tmp_path / name
    p.write_bytes(content)
    return p, p.stat()


def test_extension_case_insensitive(tmp_path):
    p, s = _stat(tmp_path, "report.TXT")
    assert matches_filter(p, s, FilterRule("extension", "equals", "txt"))
    assert matches_filter(p, s, FilterRule("extension", "equals", ".TXT"))
    assert not matches_filter(p, s, FilterRule("extension", "equals", "csv"))


def test_filename_glob(tmp_path):
    p, s = _stat(tmp_path, "archive.BAK")
    assert matches_filter(p, s, FilterRule("filename_glob", "matches", "*.bak"))
    assert not matches_filter(p, s, FilterRule("filename_glob", "matches", "*.txt"))


def test_filename_regex(tmp_path):
    p, s = _stat(tmp_path, "invoice_2024.pdf")
    assert matches_filter(p, s, FilterRule("filename_regex", "matches", r"^invoice_\d{4}"))
    assert not matches_filter(p, s, FilterRule("filename_regex", "matches", r"^receipt"))


def test_size_min_max_boundaries(tmp_path):
    p, s = _stat(tmp_path, "data.bin", content=b"x" * 100)
    assert matches_filter(p, s, FilterRule("size", "min", "100"))
    assert not matches_filter(p, s, FilterRule("size", "min", "101"))
    assert matches_filter(p, s, FilterRule("size", "max", "100"))
    assert not matches_filter(p, s, FilterRule("size", "max", "99"))


def test_modified_date_before_after(tmp_path):
    p, s = _stat(tmp_path, "old.txt")
    past = "2000-01-01"
    future = "2999-01-01"
    assert matches_filter(p, s, FilterRule("modified_date", "after", past))
    assert not matches_filter(p, s, FilterRule("modified_date", "after", future))
    assert matches_filter(p, s, FilterRule("modified_date", "before", future))
    assert not matches_filter(p, s, FilterRule("modified_date", "before", past))


def test_created_date_uses_ctime(tmp_path):
    p, s = _stat(tmp_path, "new.txt")
    assert matches_filter(p, s, FilterRule("created_date", "after", "2000-01-01"))


def test_unknown_field_raises(tmp_path):
    p, s = _stat(tmp_path, "x.txt")
    with pytest.raises(ValueError):
        matches_filter(p, s, FilterRule("bogus_field", "equals", "x"))


def test_and_combination_all_must_pass(tmp_path):
    p, s = _stat(tmp_path, "report.txt", content=b"x" * 50)
    passing = [
        FilterRule("extension", "equals", "txt"),
        FilterRule("size", "min", "10"),
    ]
    failing = [
        FilterRule("extension", "equals", "txt"),
        FilterRule("size", "min", "1000"),
    ]
    assert evaluate_filters(p, s, passing)
    assert not evaluate_filters(p, s, failing)


def test_empty_filter_list_matches_everything(tmp_path):
    p, s = _stat(tmp_path, "anything.xyz")
    assert evaluate_filters(p, s, [])


def test_any_match_mode_passes_if_one_filter_matches(tmp_path):
    p, s = _stat(tmp_path, "report.txt", content=b"x" * 50)
    filters = [
        FilterRule("extension", "equals", "txt"),  # matches
        FilterRule("size", "min", "1000"),  # does not match
    ]
    assert evaluate_filters(p, s, filters, match_mode="any")


def test_any_match_mode_fails_if_no_filter_matches(tmp_path):
    p, s = _stat(tmp_path, "report.txt", content=b"x" * 50)
    filters = [
        FilterRule("extension", "equals", "csv"),
        FilterRule("size", "min", "1000"),
    ]
    assert not evaluate_filters(p, s, filters, match_mode="any")


def test_default_match_mode_is_all(tmp_path):
    p, s = _stat(tmp_path, "report.txt", content=b"x" * 50)
    filters = [
        FilterRule("extension", "equals", "txt"),
        FilterRule("size", "min", "1000"),  # does not match
    ]
    assert not evaluate_filters(p, s, filters)
