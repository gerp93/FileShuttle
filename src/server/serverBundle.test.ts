import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import { builtinModules } from 'module';
import * as net from 'net';
import * as path from 'path';
import { build } from 'vite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, writeFile } from '../main/engine/testUtils';
import { serverBuildConfig } from '../../vite.server.config';

const ROOT = path.resolve(__dirname, '../..');
const ENTRY = path.join(ROOT, 'src/server/entry.ts');

/** Files, relative imports followed, that the server entry can reach. Fails on anything Electron-shaped. */
function importGraph(entry: string): { files: Set<string>; bare: Map<string, string> } {
  const files = new Set<string>();
  const bare = new Map<string, string>(); // specifier -> first file importing it
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)['"]([^'"]+)['"]/gm;
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (spec.startsWith('.')) {
        const base = path.resolve(path.dirname(file), spec);
        const found = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')].find((c) => fs.existsSync(c));
        if (found) visit(found);
      } else if (!bare.has(spec)) {
        bare.set(spec, file);
      }
    }
  };
  visit(entry);
  return { files, bare };
}

// The server ships only for Linux (.deb); these use POSIX paths, modes and signals, and run in CI's Linux job.
const linuxOnly = describe.skipIf(process.platform === 'win32');

describe('the server entry does not import Electron', () => {
  it('has no electron, updater or Claude SDK import anywhere in its source graph', () => {
    const { files, bare } = importGraph(ENTRY);
    expect(files.size).toBeGreaterThan(20); // the walk really followed the imports
    const forbidden = [...bare.entries()].filter(([spec]) => /^(electron|electron-|@anthropic-ai\/)/.test(spec));
    expect(forbidden).toEqual([]);
    const names = [...files].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    for (const desktopOnly of ['src/main/main.ts', 'src/main/preload.ts', 'src/main/menu.ts', 'src/main/electronPaths.ts', 'src/main/electronTrash.ts']) {
      expect(names).not.toContain(desktopOnly);
    }
    expect(names.some((n) => n.startsWith('src/main/agent/'))).toBe(false);
    // The MCP server is shared code and must be in the headless bundle.
    expect(names).toContain('src/main/mcp/mcpEndpoint.ts');
  });
});

linuxOnly('the built server bundle', () => {
  let out: string;
  let bundle: string;

  beforeAll(async () => {
    out = makeTempDir('fileshuttle-bundle-');
    await build(serverBuildConfig(path.join(out, 'server'), '9.8.7'));
    bundle = path.join(out, 'server', 'fileshuttle-server.cjs');
  }, 120_000);
  afterAll(() => removeDir(out));

  it('is one file that requires only Node built-ins (never electron or a package)', () => {
    expect(fs.readdirSync(path.join(out, 'server'))).toEqual(['fileshuttle-server.cjs']);
    const code = fs.readFileSync(bundle, 'utf8');
    const required = [...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(5);
    for (const spec of required) {
      if (spec.startsWith('node:')) continue; // node:sqlite is only reachable with the prefix
      expect(builtinModules, `unexpected require of "${spec}"`).toContain(spec.split('/')[0]);
    }
    expect(code).not.toMatch(/["']electron["']/);
  });

  it('prints the baked-in version and refuses a non-loopback host', () => {
    const version = spawnSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe('9.8.7');

    const refused = spawnSync(process.execPath, [bundle, 'all'], {
      encoding: 'utf8',
      env: { ...process.env, FILESHUTTLE_SERVER_HOST: '0.0.0.0' },
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('not a loopback address');

    // A worker that was never paired says so and does nothing.
    const worker = spawnSync(process.execPath, [bundle, 'worker'], {
      encoding: 'utf8',
      env: { ...process.env, FILESHUTTLE_WORKER_DIR: path.join(out, 'unpaired-worker') },
    });
    expect(worker.status).toBe(1);
    expect(worker.stderr).toContain('not paired');
  });

  it('pairs a worker with a running hub and keeps it connected (the real bundle on both sides)', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const hubEnv = {
      ...process.env,
      FILESHUTTLE_SERVER_DATA_DIR: path.join(out, 'pair-hub'),
      FILESHUTTLE_SERVER_WEB_DIR: path.join(out, 'web'),
      FILESHUTTLE_SERVER_PORT: String(port),
    };
    writeFile(path.join(out, 'web', 'index.html'), '<!doctype html><title>FileShuttle</title>');
    const workerEnv = { ...process.env, FILESHUTTLE_WORKER_DIR: path.join(out, 'pair-worker') };
    const collect = (child: ReturnType<typeof spawn>) => {
      const box = { text: '' };
      child.stdout?.on('data', (d) => (box.text += d));
      child.stderr?.on('data', (d) => (box.text += d));
      return box;
    };
    const hub = spawn(process.execPath, [bundle, 'hub'], { env: hubEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const hubOut = collect(hub);
    let worker: ReturnType<typeof spawn> | null = null;
    try {
      const until = async (box: { text: string }, needle: string) => {
        const deadline = Date.now() + 20_000;
        while (!box.text.includes(needle) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(box.text).toContain(needle);
      };
      await until(hubOut, 'listening on');

      const made = spawnSync(process.execPath, [bundle, 'workers', 'pair', 'Test PC'], { encoding: 'utf8', env: hubEnv });
      expect(made.status).toBe(0);
      const code = made.stdout.trim();
      expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

      const paired = spawnSync(process.execPath, [bundle, 'worker', 'pair', `http://127.0.0.1:${port}`, code], {
        encoding: 'utf8',
        env: workerEnv,
      });
      expect(paired.status, paired.stderr).toBe(0);
      expect(paired.stdout).toContain('Paired as "Test PC"');
      const token = (JSON.parse(fs.readFileSync(path.join(out, 'pair-worker', 'worker.json'), 'utf8')) as { token: string }).token;
      expect(token).toMatch(/^fsw_/);
      expect(paired.stdout + paired.stderr).not.toContain(token);
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(out, 'pair-worker', 'worker.json')).mode & 0o777).toBe(0o600);
      }

      worker = spawn(process.execPath, [bundle, 'worker'], { env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const workerExited = new Promise<number | null>((resolve) => worker!.on('exit', (c) => resolve(c)));
      const workerOut = collect(worker);
      await until(workerOut, 'hub connection: connected');
      expect(workerOut.text).not.toContain(token);

      // The hub's own list now shows it online.
      const deadline = Date.now() + 10_000;
      let listing = '';
      while (!/Test PC	remote	online/.test(listing) && Date.now() < deadline) {
        listing = spawnSync(process.execPath, [bundle, 'workers', 'list'], { encoding: 'utf8', env: hubEnv }).stdout;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(listing).toMatch(/Test PC	remote	online/);

      // Revoked from the command line, the worker is cut off and stays down.
      expect(spawnSync(process.execPath, [bundle, 'workers', 'revoke', 'Test PC'], { encoding: 'utf8', env: hubEnv }).status).toBe(0);
      await until(workerOut, 'hub connection: revoked');
      expect(hubOut.text).not.toContain(token);
      // ...and it ends with a status of its own (3), so a service manager does not restart it in a loop.
      expect(await workerExited).toBe(3);
      expect(fs.existsSync(path.join(out, 'pair-worker', 'schedule.json'))).toBe(false);
    } finally {
      worker?.kill('SIGKILL');
      hub.kill('SIGKILL');
    }
  }, 90_000);

  it('starts, serves the sign-in page and exits 0 on SIGTERM', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const data = path.join(out, 'data');
    writeFile(path.join(out, 'web', 'index.html'), '<!doctype html><title>FileShuttle</title>');
    const child = spawn(process.execPath, [bundle, 'all'], {
      env: {
        ...process.env,
        FILESHUTTLE_SERVER_DATA_DIR: data,
        FILESHUTTLE_SERVER_WEB_DIR: path.join(out, 'web'),
        FILESHUTTLE_SERVER_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      const deadline = Date.now() + 20_000;
      while (!output.includes('listening on') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(output).toContain(`http://127.0.0.1:${port}`);
      expect(output).toContain('No password is set yet');
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      expect(fs.existsSync(path.join(data, 'fileshuttle.db'))).toBe(true);
      // The checkpoint on shutdown leaves no -wal behind.
      expect(fs.existsSync(path.join(data, 'fileshuttle.db-wal')) ? fs.statSync(path.join(data, 'fileshuttle.db-wal')).size : 0).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});
