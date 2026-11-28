import { execFile } from 'child_process';

/**
 * Start-at-logon for the Windows worker, as a per-user Run key (HKCU\Software\Microsoft\Windows\CurrentVersion\Run).
 * Chosen over a Task Scheduler task because it is per user by construction, needs no admin rights, and avoids
 * the ONLOGON trigger's "access denied" for non-admins. It is not a service on purpose: the Recycle Bin and the
 * user's mapped drives belong to the logged-in user. All commands go through execFile with an argv (no shell).
 */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'FileShuttleWorker';

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class LogonError extends Error {}

export const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The command stored in the Run key: starts `<exe> worker` with no console window. */
export function logonCommand(exePath: string): string {
  const quoted = exePath.replace(/'/g, "''");
  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '${quoted}' -ArgumentList 'worker'"`;
}

/** The exact argv for `reg add`. */
export function installArgs(exePath: string): string[] {
  return ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', logonCommand(exePath), '/f'];
}

export function uninstallArgs(): string[] {
  return ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'];
}

function needWindows(platform: NodeJS.Platform): void {
  if (platform !== 'win32') throw new LogonError('Start at logon is for the Windows worker only. On Linux use the systemd unit.');
}

export async function installLogon(
  opts: { exePath?: string; platform?: NodeJS.Platform; exec?: ExecFn } = {}
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  needWindows(platform);
  const exePath = opts.exePath ?? process.execPath;
  if (/\.js$|\.cjs$/i.test(exePath) || /node(\.exe)?$/i.test(exePath)) {
    throw new LogonError('Run this from the fileshuttle-server.exe program, not through node.');
  }
  try {
    await (opts.exec ?? defaultExec)('reg', installArgs(exePath));
  } catch (err) {
    throw new LogonError(`Could not write the Run key: ${(err as Error).message}`);
  }
  return exePath;
}

/** Returns false when there was nothing to remove. */
export async function uninstallLogon(opts: { platform?: NodeJS.Platform; exec?: ExecFn } = {}): Promise<boolean> {
  needWindows(opts.platform ?? process.platform);
  try {
    await (opts.exec ?? defaultExec)('reg', uninstallArgs());
    return true;
  } catch (err) {
    const text = `${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message}`;
    if (/unable to find|cannot find|was unable/i.test(text)) return false;
    throw new LogonError(`Could not remove the Run key: ${(err as Error).message}`);
  }
}
