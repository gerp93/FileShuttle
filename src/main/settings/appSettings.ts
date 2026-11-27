import type { Database } from '../database/sqlite';
import { getSetting, setSetting } from '../database/repository';
import {
  DEFAULT_UNZIP_LIMITS_SETTING,
  UnzipLimitsSetting,
  validateUnzipLimits,
} from '../../shared/types';

/**
 * Everything in the `app_settings` table, sorted into two groups. The table and the keys are
 * unchanged (no data moved); the split is about who is allowed to read what once the app is a
 * hub plus workers.
 *
 *  - HUB settings describe the app and the person using it: theme, how long run logs are kept,
 *    phone (remote) access and its password hash, and the one-time "chains became jobs" marker.
 *    Only the hub reads or writes them. (Two more hub-side settings are not in this table:
 *    the database location and "start with Windows", which live in the config file / OS.)
 *
 *  - RUN settings change how a run executes on a machine: whether a file that an "overwrite"
 *    mapping replaces is first sent to the Recycle Bin, and the unzip safety limits. The hub
 *    edits them; the worker side reads ONLY these, through `runSettings.read`, and never
 *    touches `app_settings` any other way. When workers become separate processes the hub will
 *    send this group along with the schedule.
 *
 * A new setting must be added to exactly one group below.
 */

export const HUB_SETTING_KEYS = {
  theme: 'theme',
  logRetention: 'log_retention',
  jobsMigrated: 'jobs_migrated',
  remoteEnabled: 'remote_enabled',
  remotePort: 'remote_port',
  remotePasswordHash: 'remote_password_hash',
  remoteAllowedLogins: 'remote_allowed_logins',
} as const;

export const RUN_SETTING_KEYS = {
  overwriteBackup: 'overwrite_backup',
  unzipMaxEntries: 'unzip_max_entries',
  unzipMaxTotalGb: 'unzip_max_total_gb',
} as const;

export const DEFAULT_THEME = 'blue_oval';

/** The run settings in the units the engine uses. Plain data: it can cross the worker protocol. */
export interface RunSettings {
  /** Send a file replaced by an "overwrite" mapping to the Recycle Bin first. */
  overwriteBackup: boolean;
  unzipLimits: { maxEntries: number; maxTotalBytes: number };
}

export const hubSettings = {
  getTheme: (db: Database): string => getSetting(db, HUB_SETTING_KEYS.theme, DEFAULT_THEME) ?? DEFAULT_THEME,
  setTheme: (db: Database, themeId: string): void => setSetting(db, HUB_SETTING_KEYS.theme, themeId),
};

/** Whether files replaced by an "overwrite" mapping are first sent to the Recycle Bin. On unless turned off. */
function getOverwriteBackup(db: Database): boolean {
  return getSetting(db, RUN_SETTING_KEYS.overwriteBackup, '1') !== '0';
}

function setOverwriteBackup(db: Database, enabled: boolean): void {
  setSetting(db, RUN_SETTING_KEYS.overwriteBackup, enabled ? '1' : '0');
}

function getUnzipLimitsSetting(db: Database): UnzipLimitsSetting {
  const entries = Number(getSetting(db, RUN_SETTING_KEYS.unzipMaxEntries, null));
  const gb = Number(getSetting(db, RUN_SETTING_KEYS.unzipMaxTotalGb, null));
  const stored: UnzipLimitsSetting = {
    maxEntries: entries || DEFAULT_UNZIP_LIMITS_SETTING.maxEntries,
    maxTotalGB: gb || DEFAULT_UNZIP_LIMITS_SETTING.maxTotalGB,
  };
  return validateUnzipLimits(stored) ? DEFAULT_UNZIP_LIMITS_SETTING : stored;
}

function setUnzipLimitsSetting(db: Database, limits: UnzipLimitsSetting): void {
  const problem = validateUnzipLimits(limits);
  if (problem) throw new Error(problem);
  setSetting(db, RUN_SETTING_KEYS.unzipMaxEntries, String(limits.maxEntries));
  setSetting(db, RUN_SETTING_KEYS.unzipMaxTotalGb, String(limits.maxTotalGB));
}

export const runSettings = {
  getOverwriteBackup,
  setOverwriteBackup,
  getUnzipLimitsSetting,
  setUnzipLimitsSetting,
  /** The one call the worker side makes. */
  read(db: Database): RunSettings {
    const { maxEntries, maxTotalGB } = getUnzipLimitsSetting(db);
    return {
      overwriteBackup: getOverwriteBackup(db),
      unzipLimits: { maxEntries, maxTotalBytes: Math.floor(maxTotalGB * 1024 ** 3) },
    };
  },
};
