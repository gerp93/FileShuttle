"""In-process scheduling for mappings with schedule_type != 'manual'.
Scheduled runs only fire while the app is open — there is no OS-level
task-scheduler integration (see TODO.md for that as a future direction).
"""
import logging
import threading
from collections.abc import Callable

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from fileshuttle.db import repository as repo

logger = logging.getLogger(__name__)

_JOB_ID_PREFIX = "mapping-"


class SchedulerService:
    def __init__(
        self, conn, execute_fn: Callable[..., object],
        on_scheduled_run_complete: Callable[[int, object], None] | None = None,
    ):
        """`execute_fn` is `services.run_service.execute_mapping`, injected
        so this module never imports `engine/` directly — only the DB
        connection (to read mapping schedules) and the callable that runs
        one.

        `on_scheduled_run_complete(mapping_id, RunResult)`, if given, fires
        after each *scheduled* run finishes (not manual Run Now, which
        already gets inline feedback in the UI) — used to surface a
        background-run desktop notification."""
        self._conn = conn
        self._execute_fn = execute_fn
        self._on_scheduled_run_complete = on_scheduled_run_complete
        self._scheduler = BackgroundScheduler()

    def start(self) -> None:
        self._scheduler.start()
        self.reload_jobs()

    def shutdown(self, wait: bool = False) -> None:
        self._scheduler.shutdown(wait=wait)

    def reload_jobs(self) -> None:
        for job in self._scheduler.get_jobs():
            job.remove()

        for record in repo.list_mappings(self._conn, enabled_only=True):
            if record.schedule_type == "manual":
                continue
            trigger = self._build_trigger(record)
            if trigger is None:
                continue
            self._scheduler.add_job(
                self._run_scheduled,
                trigger=trigger,
                id=f"{_JOB_ID_PREFIX}{record.id}",
                args=[record.id],
                replace_existing=True,
            )

    def run_now(self, mapping_id: int) -> None:
        """Fires a single execution outside the persistent job schedule —
        a plain background thread, not an APScheduler one-off job, so
        manual runs are instant and can't collide with reload_jobs()."""
        thread = threading.Thread(target=self._run, args=(mapping_id, "manual"), daemon=True)
        thread.start()

    def _run_scheduled(self, mapping_id: int) -> None:
        result = self._run(mapping_id, "scheduled")
        if result is not None and self._on_scheduled_run_complete is not None:
            try:
                self._on_scheduled_run_complete(mapping_id, result)
            except Exception:
                logger.exception("on_scheduled_run_complete callback failed for mapping_id=%s", mapping_id)

    def _run(self, mapping_id: int, trigger_type: str):
        try:
            return self._execute_fn(self._conn, mapping_id, trigger_type)
        except Exception:
            logger.exception("Run failed for mapping_id=%s", mapping_id)
            return None

    @staticmethod
    def _build_trigger(record):
        if record.schedule_type == "interval":
            if not record.schedule_interval_minutes:
                return None
            return IntervalTrigger(minutes=record.schedule_interval_minutes)
        if record.schedule_type == "daily_at":
            if not record.schedule_daily_time:
                return None
            hour, minute = record.schedule_daily_time.split(":")
            return CronTrigger(hour=int(hour), minute=int(minute))
        return None
