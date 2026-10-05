import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreFromRecycleBin } from './recycleBin';
import { makeTempDir, removeDir } from './testUtils';

/**
 * These talk to the real Windows Recycle Bin through PowerShell, using only
 * files this test creates itself. The round trip is skipped in CI (a hosted
 * runner's bin is not a given); the "never touches anything" cases run anywhere
 * on Windows.
 */
const onWindows = process.platform === 'win32';
const inCI = Boolean(process.env.CI);

let dir: string;
beforeEach(() => {
  dir = makeTempDir('fileshuttle-bin-');
});
afterEach(() => removeDir(dir));

function sendToRecycleBin(filePath: string): void {
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:FS_TEST_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FS_TEST_PATH: filePath },
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`could not recycle ${filePath}: ${result.stderr?.toString()}`);
}

describe('restoreFromRecycleBin', () => {
  it.skipIf(onWindows)('reports "unsupported" off Windows', async () => {
    const [result] = await restoreFromRecycleBin([{ path: '/tmp/x', notBeforeMs: 0, notAfterMs: Date.now() }]);
    expect(result.status).toBe('unsupported');
  });

  it('returns nothing for no requests', async () => {
    expect(await restoreFromRecycleBin([])).toEqual([]);
  });

  it.skipIf(!onWindows)('refuses to restore over something that already exists', async () => {
    const existing = path.join(dir, 'already-here.txt');
    fs.writeFileSync(existing, 'x');
    const [result] = await restoreFromRecycleBin([{ path: existing, notBeforeMs: 0, notAfterMs: Date.now() + 1000 }]);
    expect(result.status).toBe('blocked');
    expect(fs.readFileSync(existing, 'utf8')).toBe('x');
  }, 60_000);

  it.skipIf(!onWindows)('reports not_found for a path that was never binned', async () => {
    const [result] = await restoreFromRecycleBin([
      { path: path.join(dir, 'never-existed.txt'), notBeforeMs: 0, notAfterMs: Date.now() + 1000 },
    ]);
    expect(result.status).toBe('not_found');
  }, 60_000);

  it.skipIf(!onWindows || inCI)(
    'restores a binned file with its original name and content, and honours the time window',
    async () => {
      const file = path.join(dir, 'round-trip.tar.gz');
      fs.writeFileSync(file, 'precious');
      sendToRecycleBin(file);
      expect(fs.existsSync(file)).toBe(false);

      // Window that ended before the file was binned: must not match it.
      const [tooEarly] = await restoreFromRecycleBin([{ path: file, notBeforeMs: 0, notAfterMs: Date.now() - 60_000 }]);
      expect(tooEarly.status).toBe('not_found');
      expect(fs.existsSync(file)).toBe(false);

      const [restored] = await restoreFromRecycleBin([
        { path: file, notBeforeMs: Date.now() - 60_000, notAfterMs: Date.now() + 60_000 },
      ]);
      expect(restored).toMatchObject({ path: file, status: 'restored' });
      expect(fs.readFileSync(file, 'utf8')).toBe('precious');

      // A second attempt must not clobber the restored file.
      const [again] = await restoreFromRecycleBin([
        { path: file, notBeforeMs: Date.now() - 60_000, notAfterMs: Date.now() + 60_000 },
      ]);
      expect(again.status).toBe('blocked');
    },
    120_000
  );
});
