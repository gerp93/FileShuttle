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

describe('the server entry does not import Electron', () => {
  it('has no electron, updater or assistant SDK import anywhere in its source graph', () => {
    const { files, bare } = importGraph(ENTRY);
    expect(files.size).toBeGreaterThan(20); // the walk really followed the imports
    const forbidden = [...bare.entries()].filter(([spec]) => /^(electron|electron-|@anthropic-ai\/)/.test(spec));
    expect(forbidden).toEqual([]);
    const names = [...files].map((f) => path.relative(ROOT, f));
    for (const desktopOnly of ['src/main/main.ts', 'src/main/preload.ts', 'src/main/menu.ts', 'src/main/electronPaths.ts', 'src/main/electronTrash.ts']) {
      expect(names).not.toContain(desktopOnly);
    }
    expect(names.some((n) => n.startsWith('src/main/agent/'))).toBe(false);
  });
});

describe('the built server bundle', () => {
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

    const worker = spawnSync(process.execPath, [bundle, 'worker'], { encoding: 'utf8' });
    expect(worker.status).toBe(2);
    expect(worker.stderr).toContain('phase 5');
  });

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
