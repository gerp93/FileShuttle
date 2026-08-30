import cron from 'node-cron';
import { Database } from 'sql.js';
import {
  DEFAULT_LOG_RETENTION,
  LOG_RETENTION_PRESETS,
  LogRetentionId,
  PurgeResult,
} from '../../shared/types';
import * as repo from '../database/repository';
import { saveDatabase } from '../database/schema';

const SETTING_KEY = 'log_retention';

export function isLogRetentionId(value: string | null | undefined): value is LogRetentionId {
  return LOG_RETENTION_PRESETS.some((preset) => preset.id === value);
}

export function getLogRetention(db: Database): LogRetentionId {
  const stored = repo.getSetting(db, SETTING_KEY, DEFAULT_LOG_RETENTION);
  return isLogRetentionId(stored) ? stored : DEFAULT_LOG_RETENTION;
}

export function setLogRetention(db: Database, id: LogRetentionId): void {
  if (!isLogRetentionId(id)) {
    throw new Error(`Unknown log retention setting: ${id}`);
  }
  repo.setSetting(db, SETTING_KEY, id);
  saveDatabase(db);
}

function presetFor(id: LogRetentionId) {
  return LOG_RETENTION_PRESETS.find((preset) => preset.id === id) ?? LOG_RETENTION_PRESETS[6];
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function purgeMessage(deleted: number, windowLabel: string | null): string {
  const noun = deleted === 1 ? 'run log' : 'run logs';
  if (windowLabel == null) {
    return `Purged all ${deleted} ${noun}.`;
  }
  return `Purged ${deleted} ${noun} older than ${windowLabel}.`;
}

export function applyRetention(db: Database, mode: 'expired' | 'all' = 'expired'): PurgeResult {
  let deleted = 0;
  let windowLabel: string | null = null;

  if (mode === 'all') {
    deleted = repo.deleteAllRuns(db);
  } else {
    const preset = presetFor(getLogRetention(db));
    if (preset.days == null) {
      saveDatabase(db);
      return { deletedRuns: 0 };
    }
    deleted = repo.deleteRunsOlderThan(db, cutoffIso(preset.days));
    windowLabel = preset.label;
  }

  if (deleted > 0) {
    const now = new Date();
    repo.recordRun(db, {
      mappingId: null,
      mappingNameSnapshot: 'Log retention',
      triggerType: 'system',
      result: repo.buildRunResult(now, now, []),
      status: 'success',
      errorMessage: purgeMessage(deleted, windowLabel),
    });
  }

  saveDatabase(db);
  return { deletedRuns: deleted };
}

export class RetentionService {
  private cronTask?: cron.ScheduledTask;

  constructor(private db: Database) {}

  start(): void {
    applyRetention(this.db, 'expired');
    this.cronTask = cron.schedule('0 0 * * *', () => {
      applyRetention(this.db, 'expired');
    });
  }

  shutdown(): void {
    this.cronTask?.stop();
    this.cronTask = undefined;
  }
}
