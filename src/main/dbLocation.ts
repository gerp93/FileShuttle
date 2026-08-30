import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

interface AppConfig {
  dbPath?: string;
}

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'app-config.json');
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
  return path.join(app.getPath('userData'), 'fileshuttle.db');
}

export function getEffectiveDbPath(): string {
  const configured = readConfig().dbPath;
  return configured && configured.trim() !== '' ? configured : getDefaultDbPath();
}

export function isUsingDefaultLocation(): boolean {
  return !readConfig().dbPath;
}

export function setDbPath(newPath: string): void {
  const currentPath = getEffectiveDbPath();
  if (!fs.existsSync(newPath) && fs.existsSync(currentPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.copyFileSync(currentPath, newPath);
  }
  writeConfig({ ...readConfig(), dbPath: newPath });
}

export function resetToDefaultDbPath(): void {
  const config = readConfig();
  delete config.dbPath;
  writeConfig(config);
}
