import * as fs from 'fs';
import * as path from 'path';
import { cleanFolderInput } from '../shared/pathSafety';
import type { FolderCheck, FolderRole } from '../shared/types';

const WINDOWS_ILLEGAL = /[<>"|?*]/;

async function statOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(target);
  } catch {
    return null;
  }
}

/** The closest existing ancestor (or the path itself) that is a folder; null when nothing up the chain is. */
export async function nearestExistingFolder(target: string): Promise<string | null> {
  let current = path.resolve(cleanFolderInput(target));
  for (;;) {
    const stat = await statOrNull(current);
    if (stat?.isDirectory()) return current;
    if (stat) return null; // a file is in the way
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Says whether a typed folder path is usable. A source must already exist; a
 * destination may not, because a run creates it, as long as its closest
 * existing ancestor is a folder.
 */
export async function checkFolder(raw: string, role: FolderRole): Promise<FolderCheck> {
  const target = cleanFolderInput(raw);
  if (!target) return { status: 'ok', message: null };

  const afterRoot = target.slice(path.parse(target).root.length);
  if (!path.isAbsolute(target)) {
    return { status: 'invalid', message: 'Enter the full path to the folder, for example C:\Users\you\Documents.' };
  }
  if (process.platform === 'win32' && WINDOWS_ILLEGAL.test(afterRoot)) {
    return { status: 'invalid', message: 'A folder path can’t contain any of < > " | ? *' };
  }

  const stat = await statOrNull(target);
  if (stat?.isDirectory()) return { status: 'ok', message: null };
  if (stat) return { status: 'not_folder', message: 'That path is a file, not a folder.' };

  if (role === 'source') {
    return { status: 'missing', message: 'This folder doesn’t exist (or can’t be reached right now).' };
  }
  const existing = await nearestExistingFolder(target);
  if (existing) {
    return { status: 'will_create', message: 'This folder doesn’t exist yet — it will be created the first time files are sent here.' };
  }
  return { status: 'missing', message: 'Neither this folder nor any folder above it can be found (is the drive connected?).' };
}
