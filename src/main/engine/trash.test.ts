import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { defaultTrash, windowsTrash, WINDOWS_TRASH_ARGS, WINDOWS_TRASH_SCRIPT } from './trash';

const winOnly = describe.skipIf(process.platform !== 'win32');

describe('windowsTrash (mocked powershell)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-trash-'));
  // These use a Windows-style absolute check, so build the cases around the platform.
  const abs = process.platform === 'win32' ? path.join(tmp, 'a.txt') : 'C:\\' + 'x';

  it('keeps the path out of the argv and sends it on stdin', async () => {
    expect(WINDOWS_TRASH_SCRIPT).toContain('SendToRecycleBin');
    expect(WINDOWS_TRASH_SCRIPT).toContain('OnlyErrorDialogs');
    expect(WINDOWS_TRASH_ARGS.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    if (process.platform !== 'win32') return;
    fs.writeFileSync(abs, 'x');
    let seen: { args: string[]; stdin: string } | null = null;
    await windowsTrash(abs, async (args, stdin) => {
      seen = { args, stdin };
      fs.rmSync(abs);
    });
    expect(seen!.stdin).toBe(abs);
    expect(seen!.args.join(' ')).not.toContain(abs);
  });

  it('throws and leaves the file when powershell fails or the file stays', async () => {
    if (process.platform !== 'win32') {
      await expect(windowsTrash('relative.txt', async () => {})).rejects.toThrow(/left in place/);
      return;
    }
    fs.writeFileSync(abs, 'x');
    await expect(windowsTrash(abs, async () => { throw new Error('boom'); })).rejects.toThrow(/left in place/);
    await expect(windowsTrash(abs, async () => {})).rejects.toThrow(/left in place/);
    expect(fs.existsSync(abs)).toBe(true);
    fs.rmSync(abs);
    await expect(windowsTrash(abs, async () => {})).rejects.toThrow(/left in place/);
  });
});

winOnly('defaultTrash on real Windows', () => {
  it('sends a file to the Recycle Bin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-trash-real-é "));
    const file = path.join(dir, "it's a file.txt");
    fs.writeFileSync(file, 'hello');
    await defaultTrash(file);
    expect(fs.existsSync(file)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
