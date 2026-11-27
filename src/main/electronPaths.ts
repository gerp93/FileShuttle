import * as path from 'path';
import { app } from 'electron';
import { setUserDataDir } from './appPaths';

// A local dev run (npm run dev) and a packaged/installed build must never
// share a userData folder. Two app instances writing the same SQLite file (and its
// -wal sidecar) is a recipe for lost or locked writes, so a dev run keeps its own data. Call this before anything else touches
// app.getPath('userData') (must run before Electron's 'ready' event).
// Desktop only: the headless server picks its data folder from its environment instead.
export function pinUserDataPath(): void {
  // Lets scripts/smoke-test.js (and anyone debugging) run against a throwaway
  // data folder instead of the real dev or installed one.
  const override = process.env.FILESHUTTLE_USER_DATA_DIR;
  if (override) {
    app.setPath('userData', override);
  } else {
    const dirName = app.isPackaged ? 'fileshuttle' : 'fileshuttle-dev';
    app.setPath('userData', path.join(app.getPath('appData'), dirName));
  }
  setUserDataDir(() => app.getPath('userData'));
}
