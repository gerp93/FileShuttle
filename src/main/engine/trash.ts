import { getLinuxTrash } from './freedesktopTrash';

/** Sends a path to the Recycle Bin. Injected so the engine can run (and be tested) outside Electron. */
export type TrashFn = (filePath: string) => Promise<void>;

let configured: TrashFn | null = null;

/** The desktop app sets Electron's `shell.trashItem` here (electronTrash.ts); nothing else needs to. */
export function setDefaultTrash(fn: TrashFn | null): void {
  configured = fn;
}

/**
 * What the engine uses when a caller passes no `trash`. Without Electron that is the freedesktop.org
 * trash on Linux; anywhere else it fails the file, because the one thing that must never happen is
 * deleting outright when the trash is unavailable.
 */
export const defaultTrash: TrashFn = async (filePath) => {
  if (configured) return configured(filePath);
  if (process.platform === 'linux') {
    return getLinuxTrash().trash(filePath);
  }
  if (process.platform === 'win32') {
    // The Windows server/worker has no Recycle Bin API without native code, so deletes are refused (never done outright).
    throw new Error('this Windows worker cannot use the Recycle Bin, so the file was left in place; use the desktop app for deletes');
  }
  throw new Error('no Recycle Bin is available here, so the file was left in place');
};
