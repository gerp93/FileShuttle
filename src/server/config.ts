import * as path from 'path';
import { isLoopbackHost } from '../shared/hostCheck';
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

export { isLoopbackHost };

function absolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path (got "${value}").`);
  return path.normalize(value);
}

/**
 * Reads the server's settings from its environment (the systemd unit loads /etc/fileshuttle-server/server.env).
 * The server holds the power to move and delete files, so it will not listen on anything but a loopback
 * address; reach it from other machines with `tailscale serve` (never Funnel).
 */
export function parseServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = absolute('FILESHUTTLE_SERVER_DATA_DIR', env.FILESHUTTLE_SERVER_DATA_DIR?.trim() || DEFAULT_DATA_DIR);
  const webDir = absolute('FILESHUTTLE_SERVER_WEB_DIR', env.FILESHUTTLE_SERVER_WEB_DIR?.trim() || DEFAULT_WEB_DIR);
  const trashDir = env.FILESHUTTLE_SERVER_TRASH_DIR?.trim()
    ? absolute('FILESHUTTLE_SERVER_TRASH_DIR', env.FILESHUTTLE_SERVER_TRASH_DIR.trim())
    : path.join(dataDir, 'Trash');

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
