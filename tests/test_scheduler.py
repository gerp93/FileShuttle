import sqlite3

import pytest
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from fileshuttle.db import repository as repo
from fileshuttle.db.schema import init_schema
from fileshuttle.scheduler.scheduler import SchedulerService


@pytest.fixture
def conn(tmp_path):
    connection = sqlite3.connect(str(tmp_path / "test.db"))
    connection.row_factory = sqlite3.Row
    init_schema(connection)
    yield connection
    connection.close()


def _noop_execute(conn, mapping_id, trigger_type):
    return None


def test_reload_jobs_skips_manual_and_disabled(conn):
    repo.create_mapping(
        conn, name="Manual", source_path="s", dest_path="d", recursive=False,
        conflict_policy="skip", enabled=True, schedule_type="manual",
        schedule_interval_minutes=None, schedule_daily_time=None, filters=[],
    )
    repo.create_mapping(
        conn, name="Disabled interval", source_path="s", dest_path="d", recursive=False,
        conflict_policy="skip", enabled=False, schedule_type="interval",
        schedule_interval_minutes=15, schedule_daily_time=None, filters=[],
    )

    service = SchedulerService(conn, _noop_execute)
    service._scheduler.start(paused=True)
    service.reload_jobs()

    assert service._scheduler.get_jobs() == []
    service.shutdown()


def test_reload_jobs_adds_interval_and_daily_jobs(conn):
    repo.create_mapping(
        conn, name="Every 30 min", source_path="s", dest_path="d", recursive=False,
        conflict_policy="skip", enabled=True, schedule_type="interval",
        schedule_interval_minutes=30, schedule_daily_time=None, filters=[],
    )
    repo.create_mapping(
        conn, name="Daily at 14:00", source_path="s", dest_path="d", recursive=False,
        conflict_policy="skip", enabled=True, schedule_type="daily_at",
        schedule_interval_minutes=None, schedule_daily_time="14:00", filters=[],
    )

    service = SchedulerService(conn, _noop_execute)
    service._scheduler.start(paused=True)
    service.reload_jobs()

    jobs = {job.id: job for job in service._scheduler.get_jobs()}
    assert len(jobs) == 2

    interval_job = next(j for j in jobs.values() if isinstance(j.trigger, IntervalTrigger))
    assert interval_job.trigger.interval.total_seconds() == 30 * 60

    daily_job = next(j for j in jobs.values() if isinstance(j.trigger, CronTrigger))
    fields = {f.name: str(f) for f in daily_job.trigger.fields}
    assert fields["hour"] == "14"
    assert fields["minute"] == "0"

    service.shutdown()


def test_reload_jobs_clears_stale_jobs(conn):
    mapping_id = repo.create_mapping(
        conn, name="Every 30 min", source_path="s", dest_path="d", recursive=False,
        conflict_policy="skip", enabled=True, schedule_type="interval",
        schedule_interval_minutes=30, schedule_daily_time=None, filters=[],
    )
    service = SchedulerService(conn, _noop_execute)
    service._scheduler.start(paused=True)
    service.reload_jobs()
    assert len(service._scheduler.get_jobs()) == 1

    repo.set_mapping_enabled(conn, mapping_id, False)
    service.reload_jobs()

    assert service._scheduler.get_jobs() == []
    service.shutdown()
