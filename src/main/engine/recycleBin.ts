import { spawn } from 'child_process';

/**
 * Restoring files from the Recycle Bin. Electron can send things *to* the bin
 * (shell.trashItem) but has no API to bring them back, so on Windows this asks
 * the Shell (the same thing Explorer's "Restore" uses) through PowerShell.
 *
 * Items are matched by their exact original path and a deletion-time window,
 * so only files FileShuttle itself binned during a given run are ever touched.
 */

export type RestoreStatus = 'restored' | 'not_found' | 'blocked' | 'error' | 'unsupported';

export interface RestoreRequest {
  /** Full original path of the file/folder to bring back. */
  path: string;
  /** Only consider bin items deleted within this window (epoch ms). */
  notBeforeMs: number;
  notAfterMs: number;
}

export interface RestoreResult {
  path: string;
  status: RestoreStatus;
  reason?: string;
}

export type RestoreFn = (requests: RestoreRequest[]) => Promise<RestoreResult[]>;

const TIMEOUT_MS = 120_000;

// Reads requests from $env:FILESHUTTLE_RESTORE_REQUESTS (JSON) so no path ever
// has to be quoted into the script text.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$requests = @($env:FILESHUTTLE_RESTORE_REQUESTS | ConvertFrom-Json)
$results = New-Object System.Collections.ArrayList

$shell = New-Object -ComObject Shell.Application
$bin = $shell.Namespace(10)
$byPath = @{}
foreach ($item in $bin.Items()) {
  try {
    $from = [string]$item.ExtendedProperty('System.Recycle.DeletedFrom')
    $name = [string]$item.ExtendedProperty('System.FileName')
    if (-not $from -or -not $name) { continue }
    $deleted = [DateTime]$item.ExtendedProperty('System.Recycle.DateDeleted')
    $deletedMs = [DateTimeOffset]::new([DateTime]::SpecifyKind($deleted, [DateTimeKind]::Utc)).ToUnixTimeMilliseconds()
    $key = (Join-Path $from $name).ToLowerInvariant()
    if (-not $byPath.ContainsKey($key)) { $byPath[$key] = New-Object System.Collections.ArrayList }
    [void]$byPath[$key].Add([pscustomobject]@{ Item = $item; DeletedMs = $deletedMs })
  } catch { continue }
}

foreach ($req in $requests) {
  $path = [string]$req.path
  $result = [ordered]@{ path = $path; status = 'error'; reason = '' }
  try {
    if (Test-Path -LiteralPath $path) {
      $result.status = 'blocked'
      $result.reason = 'something already exists at the original location'
    } else {
      $candidates = @()
      $key = $path.ToLowerInvariant()
      if ($byPath.ContainsKey($key)) {
        $candidates = @($byPath[$key] | Where-Object { $_.DeletedMs -ge $req.notBeforeMs -and $_.DeletedMs -le $req.notAfterMs } | Sort-Object DeletedMs -Descending)
      }
      if ($candidates.Count -eq 0) {
        $result.status = 'not_found'
      } else {
        $parent = Split-Path -Parent $path
        if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        $candidates[0].Item.InvokeVerb('undelete')
        $deadline = (Get-Date).AddSeconds(8)
        while (-not (Test-Path -LiteralPath $path) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
        if (Test-Path -LiteralPath $path) { $result.status = 'restored' } else { $result.reason = 'the Recycle Bin did not restore it' }
      }
    }
  } catch {
    $result.status = 'error'
    $result.reason = $_.Exception.Message
  }
  [void]$results.Add([pscustomobject]$result)
}
ConvertTo-Json -InputObject @($results) -Compress
`;

export const restoreFromRecycleBin: RestoreFn = async (requests) => {
  if (requests.length === 0) return [];
  if (process.platform !== 'win32') {
    return requests.map((r) => ({
      path: r.path,
      status: 'unsupported' as const,
      reason: 'restoring from the Recycle Bin is only supported on Windows',
    }));
  }

  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise<RestoreResult[]>((resolve) => {
    const failAll = (reason: string) =>
      resolve(requests.map((r) => ({ path: r.path, status: 'error' as const, reason })));

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, FILESHUTTLE_RESTORE_REQUESTS: JSON.stringify(requests) },
        windowsHide: true,
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill();
      failAll('timed out while talking to the Recycle Bin');
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      failAll(`could not start PowerShell: ${err.message}`);
    });

    child.on('close', () => {
      clearTimeout(timer);
      try {
        const start = stdout.indexOf('[');
        const parsed = JSON.parse(stdout.slice(start)) as RestoreResult[];
        const byPath = new Map(parsed.map((r) => [r.path, r]));
        resolve(
          requests.map(
            (r) =>
              byPath.get(r.path) ?? { path: r.path, status: 'error' as const, reason: 'no result from the Recycle Bin' }
          )
        );
      } catch {
        failAll(stderr.trim() || 'could not read the Recycle Bin');
      }
    });
  });
};
