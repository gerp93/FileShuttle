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
    filters: [],
    actionType: 'move',
    keepNewest: null,
    keepNewestPerExtension: false,
    ...overrides,
  };
}

/**
 * Writes a zip whose single entry has `unsafeName` as its stored name (e.g.
 * "../../evil.txt"). Zip libraries refuse to *create* such entries, so build a
 * normal archive under a same-length placeholder and patch the name bytes in
 * both the local header and the central directory.
 */
export function writeZipWithRawEntryName(zipPath: string, unsafeName: string, content = 'x'): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const AdmZip = require('adm-zip');
  const placeholder = 'p'.repeat(unsafeName.length);
  const zip = new AdmZip();
  zip.addFile(placeholder, Buffer.from(content));
  const bytes: Buffer = zip.toBuffer();
  const needle = Buffer.from(placeholder);
  const replacement = Buffer.from(unsafeName);
  let from = 0;
  let patched = 0;
  for (;;) {
    const at = bytes.indexOf(needle, from);
    if (at === -1) break;
    replacement.copy(bytes, at);
    patched += 1;
    from = at + needle.length;
  }
  if (patched < 2) throw new Error('expected to patch the entry name in the local header and central directory');
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, bytes);
}
