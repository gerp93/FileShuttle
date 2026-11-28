import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ScheduleSnapshot } from '../../shared/workerProtocol';
import type { ScheduleStore } from './workerRuntime';

export class WorkerConfigError extends Error {}

/** What `worker.json` holds. The hub's address and this machine's id come from pairing; the folder list is edited by hand. */
export interface WorkerConfigFile {
  hubUrl?: string;
  workerId?: string;
  name?: string;
  allowedFolders?: string[];
}

export interface WorkerConfig {
  dataDir: string;
  hubUrl: string | null;
  workerId: string | null;
  name: string;
  allowedFolders: string[];
}

export const CONFIG_FILE = 'worker.json';

export function defaultWorkerDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string {
  if (platform === 'win32') {
    return path.win32.join(env.LOCALAPPDATA?.trim() || path.win32.join(home, 'AppData', 'Local'), 'FileShuttleWorker');
  }
  return path.join(env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'), 'fileshuttle-worker');
}

function readFile(dataDir: string): WorkerConfigFile {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dataDir, CONFIG_FILE), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkerConfigError(`${path.join(dataDir, CONFIG_FILE)} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WorkerConfigError(`${path.join(dataDir, CONFIG_FILE)} must hold a JSON object.`);
  }
  const o = parsed as Record<string, unknown>;
  const out: WorkerConfigFile = {};
  if (typeof o.hubUrl === 'string') out.hubUrl = o.hubUrl;
  if (typeof o.workerId === 'string') out.workerId = o.workerId;
  if (typeof o.name === 'string') out.name = o.name;
  if (Array.isArray(o.allowedFolders)) out.allowedFolders = o.allowedFolders.filter((f): f is string => typeof f === 'string');
  return out;
}

/** Splits FILESHUTTLE_WORKER_ALLOWED_FOLDERS: ":" on Linux/macOS, ";" on Windows (the platform's PATH separator). */
export function splitFolderList(value: string, delimiter: string = path.delimiter): string[] {
  return value
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Settings: environment first (FILESHUTTLE_WORKER_DATA_DIR / _HUB / _NAME / _ALLOWED_FOLDERS), then
 * `worker.json` in the data folder. The allowed folders are set here, on the worker, and nowhere else.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const dataDirText = env.FILESHUTTLE_WORKER_DATA_DIR?.trim();
  const dataDir = dataDirText ? dataDirText : defaultWorkerDataDir(env);
  if (!path.isAbsolute(dataDir)) throw new WorkerConfigError(`FILESHUTTLE_WORKER_DATA_DIR must be an absolute path (got "${dataDir}").`);
  const file = readFile(dataDir);
  const folderEnv = env.FILESHUTTLE_WORKER_ALLOWED_FOLDERS;
  return {
    dataDir: path.normalize(dataDir),
    hubUrl: env.FILESHUTTLE_WORKER_HUB?.trim() || file.hubUrl || null,
    workerId: file.workerId ?? null,
    name: env.FILESHUTTLE_WORKER_NAME?.trim() || file.name || os.hostname(),
    allowedFolders: folderEnv !== undefined ? splitFolderList(folderEnv) : (file.allowedFolders ?? []),
  };
}

/** Saves what pairing learned, keeping the allowed folders already written by hand. */
export function savePairing(dataDir: string, pairing: { hubUrl: string; workerId: string; name: string }): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const existing = readFile(dataDir);
  const next: WorkerConfigFile = { ...existing, ...pairing, allowedFolders: existing.allowedFolders ?? [] };
  const file = path.join(dataDir, CONFIG_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** The worker's copy of the schedule. A plain file in the data folder; the hub's copy is the truth. */
export function createScheduleStore(dataDir: string): ScheduleStore {
  const file = path.join(dataDir, 'schedule.json');
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; schedule?: ScheduleSnapshot };
        if (typeof parsed.version !== 'number' || !parsed.schedule || !Array.isArray(parsed.schedule.jobs)) return null;
        return { version: parsed.version, schedule: parsed.schedule };
      } catch {
        return null;
      }
    },
    save(version, schedule) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version, schedule }), { mode: 0o600 });
      fs.renameSync(temp, file);
    },
  };
}
