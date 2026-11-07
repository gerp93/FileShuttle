import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';

export type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

// The SDK is ESM-only and this main process is CommonJS. tsc would rewrite a plain import() into
// require(), so hide it from the compiler to keep a real dynamic import.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<AgentSdk>;

/** Folder that holds node_modules/@anthropic-ai. Packaged builds use the asar-unpacked copy. */
function scopeDir(): string {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.resolve(__dirname, '../../../..');
  return path.join(root, 'node_modules', '@anthropic-ai');
}

/** The Claude Code binary the SDK ships per platform (FileShuttle needs no separate install). */
export function claudeExecutablePath(): string {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return path.join(scopeDir(), `claude-agent-sdk-${process.platform}-${process.arch}`, exe);
}

let sdkPromise: Promise<AgentSdk> | null = null;

export function loadSdk(): Promise<AgentSdk> {
  if (!sdkPromise) {
    const entry = path.join(scopeDir(), 'claude-agent-sdk', 'sdk.mjs');
    sdkPromise = dynamicImport(pathToFileURL(entry).href).catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

export function assistantAvailable(): { ok: true } | { ok: false; message: string } {
  const exe = claudeExecutablePath();
  return fs.existsSync(exe)
    ? { ok: true }
    : {
        ok: false,
        message: `The Claude runtime for this platform is missing (${exe}). Reinstall FileShuttle.`,
      };
}
