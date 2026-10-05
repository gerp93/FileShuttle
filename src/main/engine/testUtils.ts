import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MappingConfig } from '../../shared/types';

/** Test-only helpers. Not imported by any production code. */

export function makeTempDir(prefix = 'fileshuttle-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function writeFile(filePath: string, content = 'x', mtime?: Date): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mtime) fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

export function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

export function makeMapping(overrides: Partial<MappingConfig> & Pick<MappingConfig, 'sourcePath'>): MappingConfig {
  return {
    id: 1,
    name: 'test mapping',
    destPath: '',
    recursive: false,
    conflictPolicy: 'skip',
    filterMatchMode: 'all',
    filters: [],
    actionType: 'move',
    keepNewest: null,
    ...overrides,
  };
}
