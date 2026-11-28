import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../engine/testUtils';
import { createTokenStore } from './tokenStore';

// The real thing: PowerShell and DPAPI. Only on Windows (the other platforms use a 0600 file, tested elsewhere).
// This is the test that found the script was never valid PowerShell when it ran for real.
describe.skipIf(process.platform !== 'win32')('the Windows token store, against the real DPAPI', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir('fileshuttle-dpapi-');
  });
  afterEach(() => removeDir(dir));

  it('saves a token encrypted, reads it back, and clears it', async () => {
    const store = createTokenStore(dir);
    const token = 'fsw_Ab-Cd_ef0123456789"quoted"\'and a space';
    expect(await store.load()).toBeNull();
    await store.save(token);
    const file = path.join(dir, 'worker-token.dpapi');
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = fs.readFileSync(file, 'latin1');
    expect(onDisk).not.toContain('fsw_');
    expect(Buffer.from(onDisk.trim(), 'base64').toString('latin1')).not.toContain('Ab-Cd');
    expect(await store.load()).toBe(token);
    await store.clear();
    expect(await store.load()).toBeNull();
  }, 60_000);
});
