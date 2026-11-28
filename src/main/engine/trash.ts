import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
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
    return windowsTrash(filePath);
  }
  throw new Error('no Recycle Bin is available here, so the file was left in place');
};

const LEFT_IN_PLACE = 'no Recycle Bin is available here, so the file was left in place';

/**
 * A fixed script: it never contains the path. The path arrives on stdin (UTF-8), so nothing about it can be
 * read as code. Asks Windows for a Recycle Bin move only (RecycleOption.SendToRecycleBin).
 */
export const WINDOWS_TRASH_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  "[Console]::InputEncoding=[System.Text.Encoding]::UTF8;" +
  "Add-Type -AssemblyName Microsoft.VisualBasic;" +
  "$p=([Console]::In.ReadToEnd()).Trim([char]13,[char]10);" +
  "if([System.IO.Directory]::Exists($p)){[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)}" +
  "else{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)}";

export const WINDOWS_TRASH_ARGS = ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TRASH_SCRIPT];

export type PowershellRunner = (args: string[], stdin: string) => Promise<void>;

const runPowershell: PowershellRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', args, { windowsHide: true, timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
    child.stdin?.end(stdin, 'utf8');
  });

/** Windows without Electron: the signed-in user's own Recycle Bin. Any failure leaves the file where it is. */
export async function windowsTrash(filePath: string, run: PowershellRunner = runPowershell): Promise<void> {
  if (!path.win32.isAbsolute(filePath) || !fs.existsSync(filePath)) throw new Error(LEFT_IN_PLACE);
  try {
    await run(WINDOWS_TRASH_ARGS, filePath);
  } catch {
    throw new Error(LEFT_IN_PLACE);
  }
  if (fs.existsSync(filePath)) throw new Error(LEFT_IN_PLACE);
}
