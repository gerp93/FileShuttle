import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilterRule } from '../../shared/types';
import { readDownloadOrigin } from './downloadOrigin';
import { matchesFilter } from './filters';
import { runMapping } from './mover';
import { listTree, makeMapping, makeTempDir, removeDir, writeFile } from './testUtils';

const onWindows = process.platform === 'win32';
const stat = { size: 1, mtimeMs: 0, birthtimeMs: 0 };
const sourceRule = (value: string): FilterRule => ({ field: 'download_source', operator: 'matches', value, group: 0 });
const trash = async (p: string) => fs.rmSync(p, { recursive: true, force: true });

/** Marks a file the way a browser does: a Zone.Identifier alternate data stream. */
function markDownloaded(filePath: string, referrerUrl: string, hostUrl = referrerUrl): void {
  fs.writeFileSync(
    `${filePath}:Zone.Identifier`,
    `[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=${referrerUrl}\r\nHostUrl=${hostUrl}\r\n`
  );
}

describe('download_source filter rule', () => {
  it('never matches a browser temp file, even if it carries an origin', () => {
    const origin = { referrerUrl: 'https://github.com/o/r', hostUrl: null };
    for (const name of ['setup.exe.crdownload', 'setup.exe.part', 'file.tmp', 'x.opdownload']) {
      expect(matchesFilter(`C:\\in\\${name}`, { ...stat, origin }, sourceRule('github.com')), name).toBe(false);
    }
    expect(matchesFilter('C:\\in\\setup.exe', { ...stat, origin }, sourceRule('github.com'))).toBe(true);
  });

  it('does not match when no origin was read', () => {
    expect(matchesFilter('C:\\in\\setup.exe', stat, sourceRule('github.com'))).toBe(false);
  });
});

describe.skipIf(!onWindows)('download origin on real NTFS files', () => {
  let root: string;
  let src: string;
  let dest: string;

  beforeEach(() => {
    root = makeTempDir('fileshuttle-origin-');
    src = path.join(root, 'src');
    dest = path.join(root, 'dest');
    fs.mkdirSync(src);
    fs.mkdirSync(dest);
  });
  afterEach(() => removeDir(root));

  it('reads the origin out of the Zone.Identifier stream', async () => {
    const file = writeFile(path.join(src, 'a.zip'));
    markDownloaded(file, 'https://github.com/o/r/releases', 'https://objects.githubusercontent.com/a.zip');
    expect(await readDownloadOrigin(file)).toEqual({
      referrerUrl: 'https://github.com/o/r/releases',
      hostUrl: 'https://objects.githubusercontent.com/a.zip',
    });
  });

  it('reads UTF-16 and BOM-prefixed streams', async () => {
    const utf16 = writeFile(path.join(src, 'b.zip'));
    fs.writeFileSync(
      `${utf16}:Zone.Identifier`,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[ZoneTransfer]\r\nReferrerUrl=https://a.example/\r\n', 'utf16le')])
    );
    expect((await readDownloadOrigin(utf16))?.referrerUrl).toBe('https://a.example/');

    const bom = writeFile(path.join(src, 'c.zip'));
    fs.writeFileSync(`${bom}:Zone.Identifier`, '\uFEFF[ZoneTransfer]\r\nHostUrl=https://b.example/f\r\n');
    expect((await readDownloadOrigin(bom))?.hostUrl).toBe('https://b.example/f');
  });

  it('is null for a file with no stream, a missing file, or a stream with no URL', async () => {
    const plain = writeFile(path.join(src, 'plain.txt'));
    expect(await readDownloadOrigin(plain)).toBeNull();
    expect(await readDownloadOrigin(path.join(src, 'missing.txt'))).toBeNull();
    const zoneOnly = writeFile(path.join(src, 'zone.txt'));
    fs.writeFileSync(`${zoneOnly}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
    expect(await readDownloadOrigin(zoneOnly)).toBeNull();
  });

  it('moves only files downloaded from the rule\'s website and leaves the rest', async () => {
    markDownloaded(writeFile(path.join(src, 'from-github.zip')), 'https://github.com/o/r');
    markDownloaded(writeFile(path.join(src, 'from-cdn.zip')), 'https://example.com/get', 'https://objects.githubusercontent.com/z');
    markDownloaded(writeFile(path.join(src, 'from-elsewhere.zip')), 'https://example.org/');
    writeFile(path.join(src, 'no-origin.zip'));
    markDownloaded(writeFile(path.join(src, 'half.zip.crdownload')), 'https://github.com/o/r');

    const result = await runMapping(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        filters: [sourceRule('github.com'), { ...sourceRule('githubusercontent.com'), group: 0 }],
      }),
      { trash }
    );

    expect(result.filesMoved).toBe(2);
    expect(listTree(dest)).toEqual(['from-cdn.zip', 'from-github.zip']);
    expect(listTree(src)).toEqual(['from-elsewhere.zip', 'half.zip.crdownload', 'no-origin.zip']);
  });

  it('combines with other rules: from the site AND the right extension', async () => {
    markDownloaded(writeFile(path.join(src, 'a.zip')), 'https://github.com/o/r');
    markDownloaded(writeFile(path.join(src, 'b.txt')), 'https://github.com/o/r');

    await runMapping(
      makeMapping({
        sourcePath: src,
        destPath: dest,
        filters: [
          { ...sourceRule('github.com'), group: 0 },
          { field: 'extension', operator: 'equals', value: 'zip', group: 1 },
        ],
      }),
      { trash }
    );

    expect(listTree(dest)).toEqual(['a.zip']);
    expect(listTree(src)).toEqual(['b.txt']);
  });

  it('first matching mapping wins when two mappings could claim the same file', async () => {
    const file = writeFile(path.join(src, 'a.zip'));
    markDownloaded(file, 'https://github.com/o/r');
    const destA = path.join(root, 'destA');
    const destB = path.join(root, 'destB');
    fs.mkdirSync(destA);
    fs.mkdirSync(destB);

    await runMapping(makeMapping({ sourcePath: src, destPath: destA, filters: [sourceRule('github.com')] }), { trash });
    await runMapping(makeMapping({ sourcePath: src, destPath: destB, filters: [sourceRule('github.com/o')] }), { trash });

    expect(listTree(destA)).toEqual(['a.zip']);
    expect(listTree(destB)).toEqual([]);
  });
});
