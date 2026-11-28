import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, Notification, shell, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { Database } from './database/sqlite';
import { flushDatabase, initDatabase, takeRecoveryNotice } from './database/schema';
import * as repo from './database/repository';
import {
  getConfiguredDbPath,
  getEffectiveDbPath,
  getDefaultDbPath,
  isUsingDefaultLocation,
  setDbPath,
  resetToDefaultDbPath,
} from './dbLocation';
import { pinUserDataPath } from './electronPaths';
import { electronTrash } from './electronTrash';
import { setDefaultTrash } from './engine/trash';
import { logStartupStep, resetStartupLog } from './startupLog';
import { attachContextMenu, setupApplicationMenu } from './menu';
import { nearestExistingFolder } from './folderCheck';
import { isStartupEnabled, isStartupSupported, setStartupEnabled } from './services/startup';
import { createMcpHandler, callLogPath } from './mcp/mcpEndpoint';
import { createMcpToken, listMcpTokens, revokeMcpToken } from './mcp/tokens';
import { getUserDataDir } from './appPaths';
import { createHandlers } from './api/handlers';
import { RemoteController } from './remote/controller';
import { RetentionService } from './services/retention';
import { Hub } from './hub/hub';
import { InProcessSystem, startInProcessWorker } from './worker/inProcess';
import { runSettings } from './settings/appSettings';
import { getLocalWorkerId } from './database/workers';
import { HubLink } from './worker/hubLink';
import { HubLinkState, RemoteSettingsInput, RunResult, UpdateCheckResult } from '../shared/types';

pinUserDataPath();
// The desktop sends deleted files to Electron's Recycle Bin / trash (the server uses its own, engine/freedesktopTrash.ts).
setDefaultTrash(electronTrash);
app.setName('fileshuttle');
// Must match build.appId in package.json and the installer/taskbar shortcut.
// Without this, Windows uses Electron's default (electron.app.FileShuttle) and
// the pinned shortcut (com.fileshuttle.app) shows as a second taskbar icon.
app.setAppUserModelId('com.fileshuttle.app');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: Database | null = null;
// The hub owns the database side (history, schedules, commands); the worker owns the scheduler, the
// folder watchers and the mover. Both live in this process for now, linked by an in-process transport.
let hub: Hub | null = null;
let workerSystem: InProcessSystem | null = null;
// When this computer is paired with a hub on another machine it works for that hub instead of running its own jobs.
let hubLink: HubLink | null = null;
let retention: RetentionService | null = null;
let remote: RemoteController | null = null;
let announcedBackground = false;
let isQuitting = false;
// Guards against a real race: if a second launch attempt's 'second-instance'
// event lands while this process is still awaiting initDatabase() (loading
// the database takes a moment), showWindow() would see mainWindow
// as still null and create a *second* window ahead of the real startup
// flow -- one whose renderer calls the API before registerIPCHandlers() has
// run, permanently stuck showing "No handler registered" / default values,
// even though the database itself is completely fine. Only act on
// second-instance once startup has actually finished.
let appInitialized = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  // app.quit() has been observed leaving this process alive for hours
  // instead of exiting (the loser of the lock never reaches 'ready', so
  // there's no window/before-quit lifecycle to fall back on) -- force it.
  setTimeout(() => process.exit(0), 1000);
} else {
  app.on('second-instance', () => {
    if (!appInitialized) return;
    showWindow();
  });
}

// A JS-level timeout inside this same process can't help if startup is truly
// stuck on the one JS thread -- it would never get to fire either. Spawn a
// genuinely separate process (the bundled electron.exe run as plain Node via
// ELECTRON_RUN_AS_NODE) that watches startup.log from the outside and kills +
// relaunches this process if "startup complete" never shows up in time. See
// watchdog.ts for the full mechanism and the retry/give-up logic.
function spawnStartupWatchdog(): void {
  if (!app.isPackaged) return; // dev already runs isolated data + is fast; not worth it
  const watchdogScript = path.join(__dirname, 'watchdog.js');
  const logPath = path.join(app.getPath('userData'), 'startup.log');
  const attempt = process.env.FILESHUTTLE_WATCHDOG_ATTEMPT ?? '0';
  spawn(process.execPath, [watchdogScript, String(process.pid), logPath, attempt, app.getPath('exe')], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
}

// Shown the instant the window is created, before initDatabase() (and
// everything after it) has had a chance to run. Startup can stall for
// reasons outside our control (antivirus scanning a freshly-installed exe,
// slow disk, etc.) -- without this, a stalled launch looks indistinguishable
// from "nothing happened," because no window appears at all until the whole
// backend is ready.
function loadLoadingScreen(win: BrowserWindow): void {
  const html = `<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0d47a1;color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;"><p>Starting FileShuttle…</p></body></html>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showStartupError(win: BrowserWindow, error: string): void {
  const html = `<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0d47a1;color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:24px;box-sizing:border-box;"><div style="max-width:640px;"><p style="font-size:18px;margin:0 0 12px;">FileShuttle failed to start</p><pre style="white-space:pre-wrap;background:#0a3380;padding:12px;border-radius:8px;font-size:12px;">${escapeHtml(error)}</pre></div></body></html>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function loadAppContent(win: BrowserWindow): void {
  if (!app.isPackaged) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
}

function createWindow(startHidden = false): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    show: !startHidden,
    icon: path.join(__dirname, '../../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#0d47a1',
  });

  // appInitialized is only true once the backend (db, IPC handlers) is fully
  // ready -- which only happens for a window created *after* startup already
  // finished (e.g. showWindow() recreating a closed window). The very first
  // window, created before any of that has run, gets the loading screen.
  if (appInitialized) {
    loadAppContent(mainWindow);
  } else {
    loadLoadingScreen(mainWindow);
  }

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      if (!announcedBackground) {
        showTrayNotification(
          'FileShuttle is still running',
          'Scheduled jobs keep firing in the background. Use the tray icon to reopen or quit.'
        );
        announcedBackground = true;
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  attachContextMenu(mainWindow);
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow(false);
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function showTrayNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// Runs that finish while nobody is at the computer (locked screen, or no input
// for AWAY_IDLE_SECONDS) are tallied instead of toasted one by one, then shown
// as a single summary once the user is back -- otherwise a night of scheduled
// runs leaves dozens of stale toasts in the Action Center.
const AWAY_IDLE_SECONDS = 300;
const AWAY_POLL_MS = 30_000;

type RunCounts = Pick<
  RunResult,
  'filesMoved' | 'filesCopied' | 'filesDeleted' | 'filesSkipped' | 'filesErrored' | 'filesExtracted' | 'filesZipped'
>;

const pendingAway = {
  runs: 0,
  jobIds: new Set<number>(),
  totals: {
    filesMoved: 0,
    filesCopied: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    filesErrored: 0,
    filesExtracted: 0,
    filesZipped: 0,
  } as RunCounts,
};
let awayPollTimer: NodeJS.Timeout | null = null;

function isUserAway(): boolean {
  const state = powerMonitor.getSystemIdleState(AWAY_IDLE_SECONDS);
  return state === 'locked' || state === 'idle';
}

function flushAwayDigest(): void {
  if (awayPollTimer) {
    clearInterval(awayPollTimer);
    awayPollTimer = null;
  }
  if (pendingAway.runs === 0) return;

  const runs = pendingAway.runs;
  const jobs = pendingAway.jobIds.size;
  const detail = summarizeResult(pendingAway.totals);
  showTrayNotification(
    'FileShuttle: while you were away',
    `${runs} run${runs === 1 ? '' : 's'} across ${jobs} job${jobs === 1 ? '' : 's'} — ${detail}`
  );

  pendingAway.runs = 0;
  pendingAway.jobIds.clear();
  for (const key of Object.keys(pendingAway.totals) as (keyof RunCounts)[]) {
    pendingAway.totals[key] = 0;
  }
}

function notifyRunFinished(kind: string, jobId: number, result: RunResult): void {
  if (isUserAway()) {
    pendingAway.runs += 1;
    pendingAway.jobIds.add(jobId);
    for (const key of Object.keys(pendingAway.totals) as (keyof RunCounts)[]) {
      pendingAway.totals[key] += result[key];
    }
    if (!awayPollTimer) {
      awayPollTimer = setInterval(() => {
        if (!isUserAway()) flushAwayDigest();
      }, AWAY_POLL_MS);
    }
    return;
  }

  flushAwayDigest();
  const job = repo.getJob(db!, jobId);
  const jobName = job?.name ?? `job #${jobId}`;
  showTrayNotification(`FileShuttle: ${kind} run finished`, `"${jobName}" — ${summarizeResult(result)}`);
}

function summarizeResult(result: RunCounts): string {
  const parts: string[] = [];
  if (result.filesMoved) parts.push(`moved ${result.filesMoved}`);
  if (result.filesCopied) parts.push(`copied ${result.filesCopied}`);
  if (result.filesDeleted) parts.push(`deleted ${result.filesDeleted}`);
  if (result.filesZipped) parts.push(`zipped ${result.filesZipped}`);
  if (result.filesExtracted) parts.push(`extracted ${result.filesExtracted}`);
  if (result.filesSkipped) parts.push(`skipped ${result.filesSkipped}`);
  if (result.filesErrored) parts.push(`errored ${result.filesErrored}`);
  return parts.length ? parts.join(', ') : 'no matching files';
}

// Shown after startup completes (not during it, so a dialog can never stall
// the startup watchdog) when the database had to be restored from its backup.
function announceDatabaseRecovery(): void {
  const notice = takeRecoveryNotice();
  if (!notice) return;
  void dialog.showMessageBox({
    type: 'warning',
    title: 'Database restored from backup',
    message: 'FileShuttle restored your data from a backup.',
    detail: notice,
    buttons: ['OK'],
  });
}

function createTray(): void {
  const iconPath = path.join(__dirname, '../../../assets/icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('FileShuttle');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open FileShuttle', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          workerSystem?.stop();
          retention?.shutdown();
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => showWindow());
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    dialog
      .showMessageBox(mainWindow!, {
        type: 'info',
        title: 'Update ready',
        message: `FileShuttle ${info.version} has been downloaded.`,
        detail: 'Restart now to install it, or it will install automatically the next time you quit.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err);
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Failed to check for updates:', err);
  });
}

function checkForUpdatesNow(): Promise<UpdateCheckResult> {
  if (!app.isPackaged) {
    return Promise.resolve({ status: 'unsupported' });
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNotAvailable);
      autoUpdater.removeListener('error', onError);
    };
    const onAvailable = (info: { version: string }) => {
      cleanup();
      resolve({ status: 'available', version: info.version });
    };
    const onNotAvailable = () => {
      cleanup();
      resolve({ status: 'not-available' });
    };
    const onError = (err: Error) => {
      cleanup();
      const message = err?.message ?? String(err);
      resolve({
        status: 'error',
        message: message.includes('Cannot find latest')
          ? 'A new version may still be uploading — try again in a few minutes.'
          : message,
      });
    };

    autoUpdater.once('update-available', onAvailable);
    autoUpdater.once('update-not-available', onNotAvailable);
    autoUpdater.once('error', onError);
    autoUpdater.checkForUpdates().catch(onError);
  });
}

/** This app's own worker: the scheduler, watchers and mover for the jobs in its own database. */
function startLocalWorker(): void {
  if (workerSystem || !hub || !db) return;
  const database = db;
  // The local worker says hello and is sent its schedule; applying the first one starts the scheduler and the
  // watchers and catches up on anything that fired while the app wasn't running.
  workerSystem = startInProcessWorker(hub, {
    workerId: getLocalWorkerId(database),
    appVersion: app.getVersion(),
    readRunSettings: () => runSettings.read(database),
    onBackgroundRunFinished: (kind, jobId, result) => notifyRunFinished(kind, jobId, result),
    heartbeat: true,
  });
}

/** The folders this computer's own mappings read from and write to (each covers what is inside it), for the "allow these" button. */
function suggestAllowedFolders(database: Database): string[] {
  const folders = new Set<string>();
  for (const mapping of repo.listMappings(database)) {
    if (mapping.sourcePath.trim()) folders.add(mapping.sourcePath.trim());
    if (mapping.actionType !== 'delete' && mapping.destPath.trim()) folders.add(mapping.destPath.trim());
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}

function registerIPCHandlers(): void {
  const database = db!;
  hubLink = new HubLink({
    dataDir: path.join(getUserDataDir(), 'hub-link'),
    appVersion: app.getVersion(),
    readRunSettings: () => runSettings.read(database),
    onBackgroundRunFinished: (kind, jobId, result) => notifyRunFinished(kind, jobId, result),
    log: logStartupStep,
  });
  // Everything that works the same from the window and from the phone lives in one table
  // (api/handlers.ts); the HTTP server calls the very same functions.
  const handlers = createHandlers({
    getDb: () => db!,
    hub: hub!,
    reloadJobs: () => hub?.syncSchedules(),
    getVersion: () => app.getVersion(),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => handler(...args));
  }

  // The MCP server lives inside the phone-access server: same loopback bind, same Tailscale rules, its own bearer-token auth.
  const mcp = createMcpHandler({
    context: { getDb: () => db!, hub: hub!, afterChange: () => hub?.syncSchedules() },
    getDb: () => db!,
    getVersion: () => app.getVersion(),
    getLogPath: () => callLogPath(getUserDataDir()),
  });

  remote = new RemoteController({
    getDb: () => db!,
    handlers,
    mcp,
    // Same folder loadAppContent() opens in a packaged build.
    staticDir: path.join(__dirname, '../../renderer'),
    log: logStartupStep,
  });

  // Progress for every run, manual or scheduled, goes to whichever windows are open and to any phone.
  hub!.setProgressListener((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('run:progress', event);
    }
    remote?.broadcast(event);
  });

  // --- Desktop only: these never go over HTTP (see api/channels.ts) ---

  ipcMain.handle('settings:getStartup', () => ({
    supported: isStartupSupported,
    enabled: isStartupEnabled(),
  }));

  ipcMain.handle('settings:setStartup', (_, enabled: boolean) => {
    setStartupEnabled(enabled);
  });

  ipcMain.handle('dialogs:pickFolder', async (_, title: string, startAt?: string) => {
    if (!mainWindow) return null;
    mainWindow.focus();
    // Open where the field already points (or the closest folder that exists), not at the default location.
    const defaultPath = startAt?.trim() ? (await nearestExistingFolder(startAt)) ?? undefined : undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title,
      defaultPath,
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('shell:openPath', (_, filePath: string) => shell.openPath(filePath));

  ipcMain.handle('dbLocation:get', () => ({
    path: getEffectiveDbPath(),
    isDefault: isUsingDefaultLocation(),
    defaultPath: getDefaultDbPath(),
  }));

  ipcMain.handle('dbLocation:browseExisting', async () => {
    if (!mainWindow) return null;
    mainWindow.focus();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an existing FileShuttle database file',
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('dbLocation:browseNew', async () => {
    if (!mainWindow) return null;
    mainWindow.focus();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Choose a new location for the FileShuttle database',
      defaultPath: 'fileshuttle.db',
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePath ?? null;
  });

  ipcMain.handle('dbLocation:set', (_, newPath: string) => {
    setDbPath(newPath, db);
    app.relaunch();
    app.exit();
    return { success: true };
  });

  ipcMain.handle('dbLocation:resetToDefault', () => {
    resetToDefaultDbPath();
    app.relaunch();
    app.exit();
    return { success: true };
  });

  ipcMain.handle('updates:check', () => checkForUpdatesNow());

  // Connect to a hub (desktop only: a phone session must never be able to pair this computer or send its jobs anywhere).
  ipcMain.handle('hubLink:getState', (): HubLinkState => hubLink!.state());
  ipcMain.handle('hubLink:connect', async (_, input: { hubUrl: string; code: string; name?: string }) => {
    const state = await hubLink!.connect({
      hubUrl: String(input?.hubUrl ?? ''),
      code: String(input?.code ?? ''),
      name: input?.name ? String(input.name) : undefined,
    });
    // From here this computer works for the hub: its own jobs stop (nothing is deleted).
    workerSystem?.stop();
    workerSystem = null;
    return state;
  });
  ipcMain.handle('hubLink:disconnect', async () => {
    await hubLink!.disconnect();
    startLocalWorker();
    return hubLink!.state();
  });
  ipcMain.handle('hubLink:setAllowedFolders', (_, folders: string[]) =>
    hubLink!.setAllowedFolders(Array.isArray(folders) ? folders.map(String) : [])
  );
  ipcMain.handle('hubLink:suggestFolders', () => suggestAllowedFolders(db!));
  ipcMain.handle('hubLink:sendDefinitions', async (_, switchOff: boolean) => {
    // Read-only on this app's own data: the mappings and jobs stay exactly where they are.
    return hubLink!.sendDefinitions(
      { mappings: repo.listMappings(db!), jobs: repo.listJobs(db!) },
      { switchOff: switchOff === true }
    );
  });
  ipcMain.handle('hubLink:openHub', () => {
    const url = hubLink!.state().hubUrl;
    if (url) void shell.openExternal(url);
  });

  ipcMain.handle('remote:getSettings', () => remote!.state());
  ipcMain.handle('remote:setSettings', (_, input: RemoteSettingsInput) => remote!.setSettings(input ?? {}));
  ipcMain.handle('remote:setPassword', (_, password: string) => remote!.setPassword(String(password ?? '')));

  // MCP tokens are made and revoked on the PC only (IPC), never over HTTP, so a stolen phone session can't mint one.
  ipcMain.handle('mcp:listTokens', () => listMcpTokens(db!));
  ipcMain.handle('mcp:createToken', (_, name: string) => createMcpToken(db!, String(name ?? '')));
  ipcMain.handle('mcp:revokeToken', (_, name: string) => revokeMcpToken(db!, String(name ?? '')));

  // Off unless the user turned it on in Settings.
  void remote.apply();
}

app.whenReady().then(async () => {
  // Belt-and-suspenders: this callback is registered unconditionally above,
  // so make it explicit that the process which lost the single-instance
  // lock must never touch the database, even if 'ready' somehow still
  // fires for it before app.quit()/process.exit() take effect.
  if (!gotLock) return;

  resetStartupLog();
  logStartupStep('main: whenReady fired');
  spawnStartupWatchdog();

  setupApplicationMenu();

  const configuredDbPath = getConfiguredDbPath();
  if (configuredDbPath && !fs.existsSync(configuredDbPath)) {
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'Database not found',
      message: "FileShuttle can't find your configured database file.",
      detail: `Expected it at:\n${configuredDbPath}\n\nThis can happen if a drive is disconnected or a synced folder hasn't loaded yet. Reconnect it and relaunch, or switch back to the default location.`,
      buttons: ['Quit', 'Use Default Location'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) {
      resetToDefaultDbPath();
      app.relaunch();
    }
    app.exit();
    return;
  }

  const startHidden = process.argv.includes('--start-hidden');
  // Create the window (showing the loading screen) before the potentially
  // slow work below, so a stalled startup shows *something* instead of
  // nothing at all.
  logStartupStep('main: past configuredDbPath check, creating window');
  createWindow(startHidden);
  logStartupStep('main: window created');

  const logStep = logStartupStep;

  try {
    logStep('main: calling initDatabase()');
    db = await initDatabase();
    logStep('main: initDatabase() returned, calling migrateChainsToJobs()');
    repo.migrateChainsToJobs(db);
    logStep('main: migrateChainsToJobs() done, starting retention service');

    retention = new RetentionService(db);
    retention.start();
    logStep('main: retention started, constructing scheduler');

    hub = new Hub({ getDb: () => db! });
    logStep('main: hub constructed, registering IPC handlers');

    registerIPCHandlers();
    logStep('main: IPC handlers registered, loading app content');
    if (mainWindow) loadAppContent(mainWindow);
    createTray();
    appInitialized = true;
    logStep('main: startup complete');
    announceDatabaseRecovery();
    // The local worker says hello and is sent its schedule; applying the first one starts the
    // scheduler and the watchers and catches up on anything that fired while the app wasn't running.
    // Paired with a hub: work for it. Otherwise (or if its token is missing) this computer runs its own jobs.
    const working = hubLink!.isPaired() && (await hubLink!.start());
    if (!working) startLocalWorker();
    setupAutoUpdater();

    // Timers are unreliable across sleep, and files may have landed while the PC
    // was asleep: rebuild the schedules and pick up anything that was missed.
    powerMonitor.on('resume', () => {
      workerSystem?.worker.resumeFromSleep();
      hubLink?.resumeFromSleep();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(false);
      } else {
        showWindow();
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    logStep(`main: startup failed: ${message}`);
    if (mainWindow) {
      showStartupError(mainWindow, message);
    } else {
      dialog.showErrorBox('FileShuttle failed to start', message);
    }
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  workerSystem?.stop();
  hubLink?.stop();
  retention?.shutdown();
  void remote?.shutdown();
  if (db) flushDatabase(db);
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
});
