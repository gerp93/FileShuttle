import type { Database } from '../database/sqlite';
import * as repo from '../database/repository';
import { HUB_SETTING_KEYS } from '../settings/appSettings';
import {
  DEFAULT_REMOTE_PORT,
  RemoteSettings,
  RemoteSettingsInput,
} from '../../shared/types';
import { hashPassword, validatePassword, verifyPassword } from './password';

const ENABLED_KEY = HUB_SETTING_KEYS.remoteEnabled;
const PORT_KEY = HUB_SETTING_KEYS.remotePort;
const HASH_KEY = HUB_SETTING_KEYS.remotePasswordHash;
const LOGINS_KEY = HUB_SETTING_KEYS.remoteAllowedLogins;

/** Splits a comma- or newline-separated list, trims, drops blanks and repeats (case-insensitive). */
export function parseLogins(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of text.split(/[,\n\r;]+/)) {
    const login = part.trim();
    const key = login.toLowerCase();
    if (login && !seen.has(key)) {
      seen.add(key);
      result.push(login);
    }
  }
  return result;
}

export function validatePort(port: unknown): string | null {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return 'The port must be a whole number between 1024 and 65535.';
  }
  return null;
}

export function getRemoteSettings(db: Database): RemoteSettings {
  const port = Number(repo.getSetting(db, PORT_KEY, String(DEFAULT_REMOTE_PORT)));
  return {
    enabled: repo.getSetting(db, ENABLED_KEY, '0') === '1',
    port: validatePort(port) ? DEFAULT_REMOTE_PORT : port,
    hasPassword: !!repo.getSetting(db, HASH_KEY, null),
    allowedLogins: parseLogins(repo.getSetting(db, LOGINS_KEY, '') ?? ''),
  };
}

/** Validates and stores the non-secret settings. Throws a readable Error on a bad value. */
export function setRemoteSettings(db: Database, input: RemoteSettingsInput): void {
  const current = getRemoteSettings(db);
  if (input.port !== undefined) {
    const problem = validatePort(input.port);
    if (problem) throw new Error(problem);
  }
  if (input.enabled === true && !current.hasPassword) {
    throw new Error('Set a password before turning on remote access.');
  }
  if (input.allowedLogins !== undefined) {
    if (!Array.isArray(input.allowedLogins) || input.allowedLogins.some((l) => typeof l !== 'string' || l.length > 200)) {
      throw new Error('The allowed Tailscale logins must be a list of names.');
    }
    repo.setSetting(db, LOGINS_KEY, parseLogins(input.allowedLogins.join('\n')).join('\n'));
  }
  if (input.port !== undefined) repo.setSetting(db, PORT_KEY, String(input.port));
  if (input.enabled !== undefined) repo.setSetting(db, ENABLED_KEY, input.enabled ? '1' : '0');
}

/** Stores only a salted scrypt hash of the password. */
export async function setRemotePassword(db: Database, password: string): Promise<void> {
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  repo.setSetting(db, HASH_KEY, await hashPassword(password));
}

/** True when the password matches the saved one; false when none is saved. */
export function checkRemotePassword(db: Database, password: string): Promise<boolean> {
  return verifyPassword(password, repo.getSetting(db, HASH_KEY, null));
}
