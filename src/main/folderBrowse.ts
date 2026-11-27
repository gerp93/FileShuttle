import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanFolderInput } from '../shared/pathSafety';
import type { FolderEntry, FolderListing } from '../shared/types';

export const MAX_FOLDER_ENTRIES = 2000;
const DRIVE_PROBE_MS = 1500;
const WINDOWS_SKIPPED = new Set(['system volume information', 'recovery', 'config.msi', 'windows.old']);

function isHiddenName(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('$')) return true;
  return process.platform === 'win32' && WINDOWS_SKIPPED.has(name.toLowerCase());
}

function message(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'That folder doesn’t exist (or can’t be reached right now).';
  if (code === 'EACCES' || code === 'EPERM') return 'FileShuttle isn’t allowed to open that folder.';
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/** Drive letters on Windows; `/` and the home folder elsewhere. */
export async function listRoots(): Promise<FolderListing> {
  const folders: FolderEntry[] = [];
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const found = await Promise.all(
      letters.map(async (letter) => {
        const root = `${letter}:\\`;
        const ok = await withTimeout(
          fs.promises.stat(root).then((s) => s.isDirectory()),
          DRIVE_PROBE_MS,
          false
        );
        return ok ? { name: `${letter}:`, path: root } : null;
      })
    );
    for (const entry of found) if (entry) folders.push(entry);
  } else {
    folders.push({ name: '/', path: '/' });
  }
  const home = os.homedir();
  if (home && !folders.some((f) => f.path === home)) folders.unshift({ name: 'Home', path: home });
  return { path: null, parent: null, folders, truncated: false };
}

/**
 * The subfolders of a folder (folders only, hidden and system ones skipped, sorted, capped), or the
 * roots when no path is given. Problems come back as `error`, never as a throw.
 */
export async function listFolder(raw?: string | null): Promise<FolderListing> {
  const cleaned = typeof raw === 'string' ? cleanFolderInput(raw) : '';
  if (!cleaned) return listRoots();

  if (!path.isAbsolute(cleaned)) {
    return {
      path: cleaned,
      parent: null,
      folders: [],
      truncated: false,
      error: 'Enter the full path to the folder, for example /home/you/Documents or C:\\Users\\you\\Documents.',
    };
  }
  const target = path.resolve(cleaned);
  const up = path.dirname(target);
  const parent = up === target ? null : up;

  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isDirectory()) {
      return { path: target, parent, folders: [], truncated: false, error: 'That path is a file, not a folder.' };
    }
    const dirents = await fs.promises.readdir(target, { withFileTypes: true });
    const folders: FolderEntry[] = [];
    for (const dirent of dirents) {
      if (isHiddenName(dirent.name)) continue;
      let isDir = dirent.isDirectory();
      if (!isDir && dirent.isSymbolicLink()) {
        isDir = await fs.promises.stat(path.join(target, dirent.name)).then((s) => s.isDirectory(), () => false);
      }
      if (isDir) folders.push({ name: dirent.name, path: path.join(target, dirent.name) });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const truncated = folders.length > MAX_FOLDER_ENTRIES;
    return { path: target, parent, folders: truncated ? folders.slice(0, MAX_FOLDER_ENTRIES) : folders, truncated };
  } catch (err) {
    return { path: target, parent, folders: [], truncated: false, error: message(err) };
  }
}
