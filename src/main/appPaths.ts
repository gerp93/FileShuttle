/**
 * Where this program keeps its own files (config, startup log, assistant folder).
 *
 * Shared code never asks Electron for this. The desktop app (main.ts) and the headless server
 * (server/main.ts) each tell it once at startup, so nothing the server bundle imports reaches
 * `electron`.
 */
let resolver: (() => string) | null = null;

export function setUserDataDir(dir: string | (() => string)): void {
  resolver = typeof dir === 'string' ? () => dir : dir;
}

export function getUserDataDir(): string {
  if (!resolver) throw new Error('The data folder has not been set (appPaths.setUserDataDir was never called).');
  return resolver();
}
