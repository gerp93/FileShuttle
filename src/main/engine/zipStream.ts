import * as fs from 'fs';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';

/**
 * Streaming zip reading/writing. adm-zip builds whole archives in memory, which
 * is fine for a few documents and fatal for a multi-gigabyte folder. Here
 * everything flows through streams, and extraction is bounded: an archive with
 * too many entries or too much data (a "zip bomb") is refused up front, and the
 * byte budget is also enforced while writing in case the headers lie.
 */

export interface UnzipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

export const DEFAULT_UNZIP_LIMITS: UnzipLimits = {
  maxEntries: 100_000,
  maxTotalBytes: 20 * 1024 ** 3,
};

/** The archive is too big, or tries to write outside its folder. Not a corrupt-file error. */
export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchiveError';
  }
}

export interface ZipEntryInfo {
  /** Name as stored, with backslashes normalised to '/'. */
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  uncompressedSize: number;
  mtime: Date;
  /** The raw yauzl entry, needed to open its data stream. */
  raw: yauzl.Entry;
}

const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zipfile) => {
      if (err || !zipfile) reject(err ?? new Error('could not open archive'));
      else resolve(zipfile);
    });
  });
}

/**
 * Where an entry would be written inside `root`, or null if its name would
 * escape it (absolute path, drive letter, `..` segments).
 */
export function resolveEntryTarget(root: string, entryName: string): string | null {
  const clean = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(clean) || clean.includes('\0')) return null;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, clean);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;
  return target;
}

/**
 * Reads the archive's table of contents (not its data) and checks it against
 * the limits and for unsafe names. The returned entries stay valid for
 * `extractZipEntries` until `close()` is called.
 */
export async function readZipEntries(
  zipPath: string,
  limits: UnzipLimits
): Promise<{ entries: ZipEntryInfo[]; close: () => void; zipfile: yauzl.ZipFile }> {
  const zipfile = await openZip(zipPath);
  const close = () => zipfile.close();
  const entries: ZipEntryInfo[] = [];
  let declaredBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      // yauzl itself refuses names like "../x" or "/x"; report those the same way as our own check.
      zipfile.on('error', (err: Error) =>
        reject(
          /invalid relative path|absolute path/i.test(err.message)
            ? new UnsafeArchiveError(`the archive contains an unsafe path (${err.message.replace(/^.*?:\s*/, '“') }”)`)
            : err
        )
      );
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName.replace(/\\/g, '/');
        const mode = (entry.externalFileAttributes >>> 16) & FILE_TYPE_MASK;
        const info: ZipEntryInfo = {
          name,
          isDirectory: name.endsWith('/'),
          isSymlink: mode === SYMLINK_MODE,
          uncompressedSize: entry.uncompressedSize,
          mtime: entry.getLastModDate(),
          raw: entry,
        };

        if (entries.length + 1 > limits.maxEntries) {
          return reject(
            new UnsafeArchiveError(
              `the archive has more than ${limits.maxEntries.toLocaleString()} entries (raise the limit in Settings if this is expected)`
            )
          );
        }
        declaredBytes += info.uncompressedSize;
        if (declaredBytes > limits.maxTotalBytes) {
          return reject(
            new UnsafeArchiveError(
              `the archive would expand to more than ${formatBytes(limits.maxTotalBytes)} (raise the limit in Settings if this is expected)`
            )
          );
        }
        if (resolveEntryTarget('/__root__', name) === null) {
          return reject(new UnsafeArchiveError(`the archive contains an unsafe path (“${entry.fileName}”)`));
        }

        entries.push(info);
        zipfile.readEntry();
      });
      zipfile.readEntry();
    });
  } catch (err) {
    close();
    throw err;
  }

  return { entries, close, zipfile };
}

/** Caps the bytes that may pass through, in case an entry's header understates its real size. */
function byteBudget(remaining: { bytes: number }, limitText: string): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      remaining.bytes -= chunk.length;
      if (remaining.bytes < 0) {
        callback(new UnsafeArchiveError(`the archive expanded to more than ${limitText} (raise the limit in Settings if this is expected)`));
      } else {
        callback(null, chunk);
      }
    },
  });
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error('could not read archive entry'));
      else resolve(stream);
    });
  });
}

/** Extracts already-validated entries into `targetDir`. Symlink entries are skipped, never created. */
export async function extractZipEntries(
  zipfile: yauzl.ZipFile,
  entries: ZipEntryInfo[],
  targetDir: string,
  limits: UnzipLimits,
  signal?: AbortSignal
): Promise<void> {
  const root = path.resolve(targetDir);
  await fs.promises.mkdir(root, { recursive: true });
  const remaining = { bytes: limits.maxTotalBytes };
  const limitText = formatBytes(limits.maxTotalBytes);

  for (const entry of entries) {
    if (signal?.aborted) throw new Error('cancelled');
    if (entry.isSymlink) continue;
    const target = resolveEntryTarget(root, entry.name);
    if (target === null) throw new UnsafeArchiveError(`the archive contains an unsafe path (“${entry.name}”)`);

    if (entry.isDirectory) {
      await fs.promises.mkdir(target, { recursive: true });
      continue;
    }

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const input = await openEntryStream(zipfile, entry.raw);
    await pipeline(input, byteBudget(remaining, limitText), fs.createWriteStream(target));
    try {
      await fs.promises.utimes(target, entry.mtime, entry.mtime);
    } catch {
      // a timestamp we can't set is not worth failing the extraction for
    }
  }
}

async function addFolder(zip: yazl.ZipFile, dir: string, prefix: string): Promise<void> {
  const children = await fs.promises.readdir(dir, { withFileTypes: true });
  let added = 0;
  for (const child of children) {
    const full = path.join(dir, child.name);
    const entryName = `${prefix}/${child.name}`;
    if (child.isDirectory()) {
      await addFolder(zip, full, entryName);
      added += 1;
    } else if (child.isFile()) {
      zip.addFile(full, entryName);
      added += 1;
    }
    // Symlinks and other special files are not followed or archived.
  }
  if (added === 0) zip.addEmptyDirectory(prefix);
}

/**
 * Writes `<sourcePath>` (a file, or a whole folder under `entryName/`) to a new
 * zip at `outZipPath`. Streams to a temp file and renames, so a crash or error
 * never leaves a half-written archive under the final name.
 */
export async function createZip(
  sourcePath: string,
  entryName: string,
  isDirectory: boolean,
  outZipPath: string
): Promise<void> {
  const zip = new yazl.ZipFile();
  if (isDirectory) {
    await addFolder(zip, sourcePath, entryName);
  } else {
    zip.addFile(sourcePath, entryName);
  }
  zip.end();

  const tmpPath = `${outZipPath}.fileshuttle-tmp-${process.pid}-${Date.now()}`;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      pipeline(zip.outputStream, fs.createWriteStream(tmpPath)).then(resolve, reject);
    });
    await fs.promises.rename(tmpPath, outZipPath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true });
    throw err;
  }
}
