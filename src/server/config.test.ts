import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_DATA_DIR, DEFAULT_WEB_DIR, isLoopbackHost, parseServerConfig } from './config';
import { userArgs } from './cli';

describe('parseServerConfig', () => {
  it('has loopback-only, documented defaults', () => {
    expect(parseServerConfig({})).toEqual({
      dataDir: DEFAULT_DATA_DIR,
      port: 8765,
      host: '127.0.0.1',
      webDir: DEFAULT_WEB_DIR,
      trashDir: `${DEFAULT_DATA_DIR}/Trash`,
    });
  });

  it('reads the environment', () => {
    const c = parseServerConfig({
      FILESHUTTLE_SERVER_DATA_DIR: '/srv/fs',
      FILESHUTTLE_SERVER_PORT: '9000',
      FILESHUTTLE_SERVER_HOST: '::1',
      FILESHUTTLE_SERVER_WEB_DIR: '/opt/web',
      FILESHUTTLE_SERVER_TRASH_DIR: '/srv/trash',
    });
    expect(c).toEqual({ dataDir: '/srv/fs', port: 9000, host: '::1', webDir: '/opt/web', trashDir: '/srv/trash' });
  });

  it.each(['0.0.0.0', '192.168.1.5', '100.64.1.2', 'example.com', '::', '[::]'])('refuses %s without the override', (host) => {
    expect(() => parseServerConfig({ FILESHUTTLE_SERVER_HOST: host })).toThrow(ConfigError);
  });

  it('allows a non-loopback host only with the explicit override', () => {
    const c = parseServerConfig({ FILESHUTTLE_SERVER_HOST: '0.0.0.0', FILESHUTTLE_SERVER_ALLOW_NON_LOOPBACK: '1' });
    expect(c.host).toBe('0.0.0.0');
    expect(() => parseServerConfig({ FILESHUTTLE_SERVER_HOST: '0.0.0.0', FILESHUTTLE_SERVER_ALLOW_NON_LOOPBACK: 'yes' })).toThrow(ConfigError);
  });

  it('rejects a bad port and relative paths', () => {
    expect(() => parseServerConfig({ FILESHUTTLE_SERVER_PORT: '80' })).toThrow(/PORT/);
    expect(() => parseServerConfig({ FILESHUTTLE_SERVER_PORT: 'abc' })).toThrow(/PORT/);
    expect(() => parseServerConfig({ FILESHUTTLE_SERVER_DATA_DIR: 'data' })).toThrow(/absolute/);
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]'])('%s is loopback', (h) => expect(isLoopbackHost(h)).toBe(true));
  it.each(['128.0.0.1', '0.0.0.0', '10.0.0.1', 'localhost.evil.com', ''])('%s is not', (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe('userArgs', () => {
  it('skips the script when run with node', () => {
    expect(userArgs(['/usr/bin/node', '/x/fileshuttle-server.cjs', '--version'], '/usr/bin/node')).toEqual(['--version']);
  });
  it('copes with a single executable that repeats its own path, or does not', () => {
    const exe = '/usr/lib/fileshuttle-server/fileshuttle-server';
    expect(userArgs([exe, exe, 'all'], exe)).toEqual(['all']);
    expect(userArgs([exe, 'all'], exe)).toEqual(['all']);
  });
});
