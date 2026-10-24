import type { ActionType } from './types';

/**
 * Checks that stop a mapping from feeding on its own output. Pure string work
 * (no `fs`/`path`) so the renderer, the IPC layer, and the engine all enforce
 * exactly the same rules.
 */

const WINDOWS_PATH = /^([a-zA-Z]:[\\/]|[\\/]{2})/;

/** A typed or pasted folder path with the whitespace and the quotes Explorer's "Copy as path" adds removed. */
export function cleanFolderInput(raw: string): string {
  let text = raw.trim();
  if (text.length >= 2 && /^(["'])[\s\S]*\1$/.test(text)) text = text.slice(1, -1).trim();
  return text;
}

/** Canonical form for comparing folders: forward slashes, no trailing slash, case-folded on Windows. */
export function normalizeFolder(folder: string): string {
  let normalized = folder.trim().replace(/\\/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/') && !/^[a-zA-Z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  // Windows paths are case-insensitive; POSIX ones are not.
  return WINDOWS_PATH.test(folder.trim()) ? normalized.toLowerCase() : normalized;
}

export function isSameFolder(a: string, b: string): boolean {
  return normalizeFolder(a) === normalizeFolder(b);
}

/** True when `child` is `parent` itself or lies anywhere beneath it. */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = normalizeFolder(child);
  const p = normalizeFolder(parent);
  if (c === p) return true;
  const prefix = p.endsWith('/') ? p : `${p}/`;
  return c.startsWith(prefix);
}

export interface MappingPaths {
  actionType: ActionType;
  sourcePath: string;
  destPath: string;
  recursive: boolean;
}

/** Returns a human-readable problem with the mapping's folders, or null when they are fine. */
export function validateMappingPaths(mapping: MappingPaths): string | null {
  const { actionType, sourcePath, destPath, recursive } = mapping;
  if (actionType === 'delete') return null;
  if (!sourcePath.trim() || !destPath.trim()) return null; // "required" is reported elsewhere

  if (isSameFolder(sourcePath, destPath)) {
    return 'The source and destination can’t be the same folder.';
  }

  // Zip always wraps every top-level entry, so a destination anywhere inside
  // the source would be swept into its own archives. For the other actions it
  // only matters when subfolders are walked.
  const walksIntoDest = actionType === 'zip' || recursive;
  if (walksIntoDest && isSameOrInside(destPath, sourcePath)) {
    return actionType === 'zip'
      ? 'The destination can’t be inside the source folder — it would be zipped into its own archives.'
      : 'The destination can’t be inside the source folder when subfolders are included — each run would pick up its own output. Turn off “Include subfolders” or choose a destination outside the source.';
  }

  return null;
}
