import * as path from 'path';
import * as fs from 'fs';
import { getUserDataDir } from './appPaths';
import { copyDatabaseFile } from './database/dbFile';
import type { Database } from './database/sqlite';

interface AppConfig {
  dbPath?: string;
}

function getConfigPath(): string {
  return path.join(getUserDataDir(), 'app-config.json');
}

function readConfig(): AppConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: AppConfig): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export function getDefaultDbPath(): string {
  return path.join(getUserDataDir(), 'fileshuttle.db');
}

// The raw configured override, if any — does NOT fall back to the default.
// Use this to detect a missing custom path before silently creating a new,
// empty database in its place.
export function getConfiguredDbPath(): string | undefined {
  const configured = readConfig().dbPath;
  return configured && configured.trim() !== '' ? configured : undefined;
}

export function getEffectiveDbPath(): string {
  return getConfiguredDbPath() ?? getDefaultDbPath();
}

export function isUsingDefaultLocation(): boolean {
  return !getConfiguredDbPath();
}

// `db` is the open connection to the current file, if any: the copy then goes through
// VACUUM INTO so commits still in the -wal sidecar come along.
export function setDbPath(newPath: string, db?: Database | null): void {
  const currentPath = getEffectiveDbPath();
  if (!fs.existsSync(newPath) && fs.existsSync(currentPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    copyDatabaseFile(currentPath, newPath, db);
  }
  writeConfig({ ...readConfig(), dbPath: newPath });
}

export function resetToDefaultDbPath(): void {
  const config = readConfig();
  delete config.dbPath;
  writeConfig(config);
}
