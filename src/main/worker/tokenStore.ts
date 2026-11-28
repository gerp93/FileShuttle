import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Where a remote worker keeps the secret it proves itself to the hub with.
 *
 * Linux and macOS: a file readable by its owner only (0600) in a folder only the owner can open
 * (0700), written to a temporary file and renamed so a crash never leaves half a token.
 * Windows: the token is encrypted with DPAPI for the current user (PowerShell's
 * ProtectedData), so the file is useless to another account or machine. The token goes to
 * PowerShell on its standard input, never on the command line.
 */
export interface TokenStore {
  save(token: string): Promise<void>;
  load(): Promise<string | null>;
  clear(): Promise<void>;
}

/** Runs the DPAPI step. `input` and the answer are base64. Injectable so tests need no PowerShell. */
export type DpapiRunner = (mode: 'protect' | 'unprotect', inputBase64: string) => Promise<string>;

const FILE_NAME = 'worker-token';
const DPAPI_FILE_NAME = 'worker-token.dpapi';

// A constant: the data never becomes part of it.
const POWERSHELL_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$mode = [Console]::In.ReadLine()',
  '$data = [Convert]::FromBase64String([Console]::In.ReadLine())',
  '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  'if ($mode -eq "protect") { $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $null, $scope) }',
  'else { $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $null, $scope) }',
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join('; ');

export const runPowerShellDpapi: DpapiRunner = (mode, inputBase64) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT],
      { timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        if (err) reject(new Error('Windows could not protect or read the saved token (DPAPI).'));
        else resolve(stdout.trim());
      }
    );
    child.stdin?.end(`${mode}\n${inputBase64}\n`);
  });

function writeAtomic(file: string, data: string, mode: number): void {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

export function createTokenStore(
  dir: string,
  opts: { platform?: NodeJS.Platform; dpapi?: DpapiRunner } = {}
): TokenStore {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    const dpapi = opts.dpapi ?? runPowerShellDpapi;
    const file = path.join(dir, DPAPI_FILE_NAME);
    return {
      async save(token) {
        fs.mkdirSync(dir, { recursive: true });
        const sealed = await dpapi('protect', Buffer.from(token, 'utf8').toString('base64'));
        writeAtomic(file, sealed, 0o600);
      },
      async load() {
        let sealed: string;
        try {
          sealed = fs.readFileSync(file, 'utf8').trim();
        } catch {
          return null;
        }
        if (!sealed) return null;
        return Buffer.from(await dpapi('unprotect', sealed), 'base64').toString('utf8');
      },
      async clear() {
        fs.rmSync(file, { force: true });
      },
    };
  }

  const file = path.join(dir, FILE_NAME);
  return {
    async save(token) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      writeAtomic(file, token, 0o600);
    },
    async load() {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
      // Tighten a file somebody loosened; the secret is only for its owner.
      try {
        fs.chmodSync(file, 0o600);
        fs.chmodSync(dir, 0o700);
      } catch {
        // Not ours to change; carry on.
      }
      const token = text.trim();
      return token || null;
    },
    async clear() {
      fs.rmSync(file, { force: true });
    },
  };
}
