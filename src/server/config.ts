import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { validatePort } from '../main/remote/remoteSettings';
import { DEFAULT_REMOTE_PORT } from '../shared/types';

/** The version baked in by `npm run build:server` (vite.server.config.ts); "0.0.0-dev" when run from source. */
export const APP_VERSION: string = process.env.APP_VERSION || '0.0.0-dev';

export const DEFAULT_DATA_DIR = '/var/lib/fileshuttle-server';
export const DEFAULT_WEB_DIR = '/usr/lib/fileshuttle-server/web';
export const DEFAULT_HOST = '127.0.0.1';

export interface ServerConfig {
  /** Everything the server writes: the database, config and the trash. */
  dataDir: string;
  /** TCP port. */
  port: number;
  /** Always a loopback address unless FILESHUTTLE_SERVER_ALLOW_NON_LOOPBACK=1. */
  host: string;
  /** The built web UI. */
  webDir: string;
  /** The Linux "home trash" (freedesktop.org layout). */
  trashDir: string;
}

export class ConfigError extends Error {}

/** 127.0.0.0/8, ::1 and "localhost". A host NAME is never trusted to be loopback (except localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (h.toLowerCase() === 'localhost') return true;
  const family = net.isIP(h);
  if (family === 4) return h.split('.')[0] === '127';
  if (family === 6) {
    const lower = h.toLowerCase();
    return lower === '::1' || /^(0{0,4}:){1,6}0{0,3}1$/.test(lower) || lower.startsWith('::ffff:127.');
  }
  return false;
}

function absolute(name: string, value: string, p: typeof path = path): string {
  if (!p.isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path (got "${value}").`);
  return p.normalize(value);
}

/**
 * Where the server keeps its data and finds its web UI when nothing is set. On Linux these are the
 * .deb's fixed paths. On Windows there is no /var/lib: the data lives in the user's local app data and the
 * web UI is the "web" folder beside the .exe (that is how the Windows zip is laid out).
 */
export function defaultPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
  home: string = os.homedir()
): { dataDir: string; webDir: string } {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || path.win32.join(home, 'AppData', 'Local');
    return { dataDir: path.win32.join(local, 'FileShuttleServer'), webDir: path.win32.join(path.win32.dirname(execPath), 'web') };
  }
  return { dataDir: DEFAULT_DATA_DIR, webDir: DEFAULT_WEB_DIR };
}

/**
 * Reads the server's settings from its environment (the systemd unit loads /etc/fileshuttle-server/server.env).
 * The server holds the power to move and delete files, so it will not listen on anything but a loopback
 * address; reach it from other machines with `tailscale serve` (never Funnel).
 */
export function parseServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath
): ServerConfig {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const defaults = defaultPaths(env, platform, execPath);
  const dataDir = absolute('FILESHUTTLE_SERVER_DATA_DIR', env.FILESHUTTLE_SERVER_DATA_DIR?.trim() || defaults.dataDir, p);
  const webDir = absolute('FILESHUTTLE_SERVER_WEB_DIR', env.FILESHUTTLE_SERVER_WEB_DIR?.trim() || defaults.webDir, p);
  const trashDir = env.FILESHUTTLE_SERVER_TRASH_DIR?.trim()
    ? absolute('FILESHUTTLE_SERVER_TRASH_DIR', env.FILESHUTTLE_SERVER_TRASH_DIR.trim(), p)
    : p.join(dataDir, 'Trash');

  const portText = env.FILESHUTTLE_SERVER_PORT?.trim();
  const port = portText ? Number(portText) : DEFAULT_REMOTE_PORT;
  const portProblem = validatePort(port);
  if (portProblem) throw new ConfigError(`FILESHUTTLE_SERVER_PORT: ${portProblem}`);

  const host = env.FILESHUTTLE_SERVER_HOST?.trim() || DEFAULT_HOST;
  if (!isLoopbackHost(host) && env.FILESHUTTLE_SERVER_ALLOW_NON_LOOPBACK !== '1') {
    throw new ConfigError(
      `FILESHUTTLE_SERVER_HOST "${host}" is not a loopback address. This server can move and delete files, so it only ` +
        `listens on 127.0.0.1 / ::1 and is reached through "tailscale serve" (never Funnel). ` +
        `To override on purpose, also set FILESHUTTLE_SERVER_ALLOW_NON_LOOPBACK=1.`
    );
  }
  return { dataDir, port, host, webDir, trashDir };
}
