import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RestoreFn, RestoreRequest, RestoreResult } from './recycleBin';
import type { TrashFn } from './trash';

/**
 * The freedesktop.org Trash specification (https://specifications.freedesktop.org/trash-spec/),
 * for the headless Linux server where there is no desktop shell to ask.
 *
 *  - Home trash: `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`) with `files/` and `info/`.
 *    Used when the file is on the same device as the home trash (a rename, never a copy).
 *  - Any other filesystem: the trash of that mount's top directory, `$topdir/.Trash/$uid` when the
 *    admin made a sticky, non-symlink `$topdir/.Trash`, else `$topdir/.Trash-$uid`.
 *  - Each trashed item gets a `.trashinfo` (percent-encoded `Path`, local `DeletionDate`).
 *
 * Safety rules: it only ever renames (never copies and never deletes), so if an item cannot be
 * trashed the error is thrown and the file stays where it was. Restore never overwrites.
 */

export interface FreedesktopTrashOptions {
  /** The home trash folder. Default: $XDG_DATA_HOME/Trash, else ~/.local/share/Trash. */
  homeTrashDir?: string;
  /** The user id used in `.Trash-$uid`. Default: process.getuid(). */
  uid?: number;
  /** Test seam: true when `file` is on the same filesystem as `dir`. */
  sameDevice?: (file: string, dir: string) => Promise<boolean>;
  /** Test seam: the top directory of the mount the (existing) directory `dir` is on. */
  topdirOf?: (dir: string) => Promise<string>;
  /** Test seam. */
  now?: () => Date;
}

export function defaultHomeTrashDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Trash');
}

// "Path" is percent-encoded per RFC 3986: everything but unreserved characters and "/" is escaped, byte by byte.
export function encodeTrashPath(p: string): string {
  let out = '';
  for (const byte of Buffer.from(p, 'utf8')) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~/]/.test(c) ? c : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function decodeTrashPath(encoded: string): string | null {
  try {
    const bytes: number[] = [];
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%') {
        const hex = encoded.slice(i + 1, i + 3);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(...Buffer.from(encoded[i], 'utf8'));
      }
    }
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time, no zone, as the spec asks: YYYY-MM-DDThh:mm:ss. */
export function formatDeletionDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function parseDeletionDate(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function parseTrashInfo(text: string): { path: string; deletionMs: number } | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '[Trash Info]') return null;
  let rawPath: string | null = null;
  let date: string | null = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith('Path=') && rawPath === null) rawPath = line.slice(5);
    else if (line.startsWith('DeletionDate=') && date === null) date = line.slice(13);
  }
  if (rawPath === null || date === null) return null;
  const decoded = decodeTrashPath(rawPath);
  const deletionMs = parseDeletionDate(date);
  if (decoded === null || deletionMs === null) return null;
  return { path: decoded, deletionMs };
}

async function defaultSameDevice(file: string, dir: string): Promise<boolean> {
  const [a, b] = await Promise.all([fs.promises.lstat(file), fs.promises.stat(dir)]);
  return a.dev === b.dev;
}

/** Walks up from the directory while the parent is on the same device: the highest such directory is the mount's top. */
async function defaultTopdirOf(dir: string): Promise<string> {
  const dev = (await fs.promises.stat(dir)).dev;
  let current = dir;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    const st = await fs.promises.stat(parent);
    if (st.dev !== dev) return current;
    current = parent;
  }
}

async function ensureTrashDir(dir: string): Promise<void> {
  await fs.promises.mkdir(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(path.join(dir, 'info'), { recursive: true, mode: 0o700 });
}

async function isStickyRealDir(dir: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(dir);
    return st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o1000) !== 0;
  } catch {
    return false;
  }
}

async function pathPresent(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export function createFreedesktopTrash(options: FreedesktopTrashOptions = {}): { trash: TrashFn; restore: RestoreFn } {
  const homeTrash = options.homeTrashDir ?? defaultHomeTrashDir();
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const sameDevice = options.sameDevice ?? defaultSameDevice;
  const topdirOf = options.topdirOf ?? defaultTopdirOf;
  const now = options.now ?? (() => new Date());

  /** Which trash folder an item at `file` goes to, and what its info Path should be relative to (null = absolute). */
  async function trashFor(file: string): Promise<{ dir: string; base: string | null }> {
    await ensureTrashDir(homeTrash);
    if (await sameDevice(file, homeTrash)) return { dir: homeTrash, base: null };

    const top = await topdirOf(path.dirname(file));
    const shared = path.join(top, '.Trash');
    const dir = (await isStickyRealDir(shared)) ? path.join(shared, String(uid)) : path.join(top, `.Trash-${uid}`);
    try {
      await ensureTrashDir(dir);
    } catch (err) {
      throw new Error(`cannot create a trash folder on that drive (${dir}): ${err instanceof Error ? err.message : String(err)}`);
    }
    return { dir, base: top };
  }

  const trash: TrashFn = async (filePath) => {
    const abs = path.resolve(filePath);
    await fs.promises.lstat(abs); // throws ENOENT: nothing to trash
    const { dir, base } = await trashFor(abs);
    const recordedPath = base ? path.relative(base, abs) : abs;
    const stamp = formatDeletionDate(now());
    const info = `[Trash Info]\nPath=${encodeTrashPath(recordedPath)}\nDeletionDate=${stamp}\n`;
    const baseName = path.basename(abs);

    for (let n = 1; n < 10_000; n++) {
      const name = n === 1 ? baseName : `${baseName}.${n}`;
      const infoPath = path.join(dir, 'info', `${name}.trashinfo`);
      const target = path.join(dir, 'files', name);
      if (await pathPresent(target)) continue;
      try {
        // "wx": the info file is how a name is reserved, so two trashers never pick the same one.
        await fs.promises.writeFile(infoPath, info, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      try {
        await fs.promises.rename(abs, target);
      } catch (err) {
        await fs.promises.unlink(infoPath).catch(() => undefined);
        throw err;
      }
      return;
    }
    throw new Error('could not find a free name in the trash');
  };

  async function candidateTrashes(file: string): Promise<{ dir: string; base: string | null }[]> {
    const list: { dir: string; base: string | null }[] = [{ dir: homeTrash, base: null }];
    // The item was binned from `file`'s own drive, so look at that drive's trash too. The file is gone,
    // so work from its nearest existing parent.
    let anchor = path.dirname(file);
    while (!(await pathPresent(anchor)) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
    try {
      const top = await topdirOf(anchor);
      if (await isStickyRealDir(path.join(top, '.Trash'))) list.push({ dir: path.join(top, '.Trash', String(uid)), base: top });
      list.push({ dir: path.join(top, `.Trash-${uid}`), base: top });
    } catch {
      // no known mount: only the home trash is searched
    }
    return list;
  }

  async function restoreOne(req: RestoreRequest): Promise<RestoreResult> {
    const target = path.resolve(req.path);
    if (await pathPresent(target)) {
      return { path: req.path, status: 'blocked', reason: 'something already exists at the original location' };
    }
    let best: { dir: string; name: string; deletionMs: number } | null = null;
    for (const { dir, base } of await candidateTrashes(target)) {
      let names: string[];
      try {
        names = await fs.promises.readdir(path.join(dir, 'info'));
      } catch {
        continue;
      }
      for (const entry of names) {
        if (!entry.endsWith('.trashinfo')) continue;
        let parsed: ReturnType<typeof parseTrashInfo>;
        try {
          parsed = parseTrashInfo(await fs.promises.readFile(path.join(dir, 'info', entry), 'utf8'));
        } catch {
          continue;
        }
        if (!parsed) continue;
        const original = path.resolve(base && !path.isAbsolute(parsed.path) ? path.join(base, parsed.path) : parsed.path);
        if (original !== target) continue;
        // The DeletionDate has one-second resolution and no zone; callers pass a window with slack.
        if (parsed.deletionMs < req.notBeforeMs || parsed.deletionMs > req.notAfterMs) continue;
        const name = entry.slice(0, -'.trashinfo'.length);
        if (!(await pathPresent(path.join(dir, 'files', name)))) continue;
        if (!best || parsed.deletionMs > best.deletionMs) best = { dir, name, deletionMs: parsed.deletionMs };
      }
    }
    if (!best) return { path: req.path, status: 'not_found' };

    const from = path.join(best.dir, 'files', best.name);
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const st = await fs.promises.lstat(from);
      if (st.isDirectory()) {
        // rename() onto an existing EMPTY directory would succeed; the check above makes that a narrow race.
        await fs.promises.rename(from, target);
      } else {
        try {
          // link() fails if the target exists, so a file that appeared meanwhile is never overwritten.
          await fs.promises.link(from, target);
          await fs.promises.unlink(from);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            return { path: req.path, status: 'blocked', reason: 'something already exists at the original location' };
          }
          if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw err;
          if (await pathPresent(target)) {
            return { path: req.path, status: 'blocked', reason: 'something already exists at the original location' };
          }
          await fs.promises.rename(from, target); // a filesystem without hard links
        }
      }
      await fs.promises.unlink(path.join(best.dir, 'info', `${best.name}.trashinfo`)).catch(() => undefined);
      return { path: req.path, status: 'restored' };
    } catch (err) {
      return { path: req.path, status: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const restore: RestoreFn = async (requests) => {
    const results: RestoreResult[] = [];
    for (const req of requests) results.push(await restoreOne(req));
    return results;
  };

  return { trash, restore };
}

let linuxShared: { trash: TrashFn; restore: RestoreFn } | null = null;
let linuxOptions: FreedesktopTrashOptions = {};

/** Sets where the process-wide Linux trash keeps its home trash (the server uses a folder inside its data folder). */
export function configureLinuxTrash(options: FreedesktopTrashOptions): void {
  linuxOptions = options;
  linuxShared = null;
}

/** The process-wide trash/restore pair the engine uses by default on Linux. */
export function getLinuxTrash(): { trash: TrashFn; restore: RestoreFn } {
  linuxShared ??= createFreedesktopTrash(linuxOptions);
  return linuxShared;
}
