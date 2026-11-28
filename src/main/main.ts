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
import { RemoteHubEnableInput, RemoteSettingsInput, RunResult, UpdateCheckResult } from '../shared/types';
import { RemoteHubManager } from './remoteHub/remoteHubManager';
import { buildSetupPayload } from './remoteHub/setupExport';
import { decideNavigation, decideNewWindow } from './remoteHub/navigation';
import { remoteHubPageUrl } from './remoteHub/localPage';

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
let retention: RetentionService | null = null;
let remote: RemoteController | null = null;
// "Use a remote hub": the manager owns the setting, the token and the worker that serves the remote hub.
// While it is on, `localHubActive` is false: no scheduler, no phone server, no MCP, no retention, and no
// in-process worker. The local database is left alone (it is only read, to offer the one-time setup export).
let remoteHubManager: RemoteHubManager | null = null;
let localHubActive = false;
let remoteWindow: BrowserWindow | null = null;
let remoteStatusWindow: BrowserWindow | null = null;
const registeredChannels = new Set<string>();
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
  const win = new BrowserWindow({
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
  mainWindow = win;

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
    // A window made after this one was destroyed must not be forgotten.
    if (mainWindow === win) mainWindow = null;
  });

  attachContextMenu(mainWindow);
}

function showWindow(): void {
  if (remoteHubManager?.isEnabled() && !localHubActive) {
    void showRemoteMode();
    return;
  }
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

function notifyRunFinished(kind: string, jobId: number, result: RunResult, local = true): void {
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
  // The remote hub's job ids are not this computer's, so its jobs are never looked up here.
  const job = local && db ? repo.getJob(db, jobId) : null;
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
          remoteHubManager?.shutdown();
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

/** Registers (or re-registers, after the local hub comes back) one IPC channel. */
function handle(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  if (registeredChannels.has(channel)) ipcMain.removeHandler(channel);
  registeredChannels.add(channel);
  ipcMain.handle(channel, listener);
}

function registerIPCHandlers(): void {
  // Everything that works the same from the window and from the phone lives in one table
  // (api/handlers.ts); the HTTP server calls the very same functions.
  const handlers = createHandlers({
    getDb: () => db!,
    hub: hub!,
    reloadJobs: () => hub?.syncSchedules(),
    getVersion: () => app.getVersion(),
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    handle(channel, (_event, ...args) => handler(...args));
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

  handle('settings:getStartup', () => ({
    supported: isStartupSupported,
    enabled: isStartupEnabled(),
  }));

  handle('settings:setStartup', (_, enabled: boolean) => {
    setStartupEnabled(enabled);
  });

  handle('dialogs:pickFolder', async (_, title: string, startAt?: string) => {
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

  handle('shell:openPath', (_, filePath: string) => shell.openPath(filePath));

  handle('dbLocation:get', () => ({
    path: getEffectiveDbPath(),
    isDefault: isUsingDefaultLocation(),
    defaultPath: getDefaultDbPath(),
  }));

  handle('dbLocation:browseExisting', async () => {
    if (!mainWindow) return null;
    mainWindow.focus();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an existing FileShuttle database file',
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  handle('dbLocation:browseNew', async () => {
    if (!mainWindow) return null;
    mainWindow.focus();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Choose a new location for the FileShuttle database',
      defaultPath: 'fileshuttle.db',
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });
    return result.canceled ? null : result.filePath ?? null;
  });

  handle('dbLocation:set', (_, newPath: string) => {
    setDbPath(newPath, db);
    app.relaunch();
    app.exit();
    return { success: true };
  });

  handle('dbLocation:resetToDefault', () => {
    resetToDefaultDbPath();
    app.relaunch();
    app.exit();
    return { success: true };
  });

  handle('updates:check', () => checkForUpdatesNow());

  handle('remote:getSettings', () => remote!.state());
  handle('remote:setSettings', (_, input: RemoteSettingsInput) => remote!.setSettings(input ?? {}));
  handle('remote:setPassword', (_, password: string) => remote!.setPassword(String(password ?? '')));

  // MCP tokens are made and revoked on the PC only (IPC), never over HTTP, so a stolen phone session can't mint one.
  handle('mcp:listTokens', () => listMcpTokens(db!));
  handle('mcp:createToken', (_, name: string) => createMcpToken(db!, String(name ?? '')));
  handle('mcp:revokeToken', (_, name: string) => revokeMcpToken(db!, String(name ?? '')));

  // Off unless the user turned it on in Settings.
  void remote.apply();
}


// ---------------------------------------------------------------- the local hub, on and off

/** Opens the database (once) and runs this computer's own hub: retention, the hub, its handlers and the in-process worker. */
async function startLocalHub(): Promise<void> {
  if (localHubActive) return;
  if (!db) {
    db = await initDatabase();
    repo.migrateChainsToJobs(db);
  }
  const database = db;
  retention = new RetentionService(database);
  retention.start();
  hub = new Hub({ getDb: () => db! });
  registerIPCHandlers();
  localHubActive = true;
  // The local worker says hello and is sent its schedule; applying the first one starts the
  // scheduler and the watchers and catches up on anything that fired while the app wasn't running.
  workerSystem = startInProcessWorker(hub, {
    workerId: getLocalWorkerId(database),
    appVersion: app.getVersion(),
    readRunSettings: () => runSettings.read(database),
    onBackgroundRunFinished: (kind, jobId, result) => notifyRunFinished(kind, jobId, result),
    heartbeat: true,
  });
}

/** Stops everything the local hub runs. The database file is left exactly as it is (it is the backup). */
async function stopLocalHub(): Promise<void> {
  localHubActive = false;
  workerSystem?.stop();
  workerSystem = null;
  retention?.shutdown();
  retention = null;
  const controller = remote;
  remote = null;
  await controller?.shutdown(); // the phone server and the MCP endpoint
  hub = null;
}

function getRemoteHubManager(): RemoteHubManager {
  remoteHubManager ??= new RemoteHubManager({
    dir: path.join(getUserDataDir(), 'remote-hub'),
    appVersion: app.getVersion(),
    localHub: { suspend: stopLocalHub, resume: startLocalHub },
    buildSetup: () => buildSetupPayload(db!),
    log: logStartupStep,
    onBackgroundRunFinished: (kind, jobId, result) => notifyRunFinished(kind, jobId, result, false),
  });
  return remoteHubManager;
}

// ---------------------------------------------------------------- remote mode: windows

function refreshMenu(): void {
  const remoteMode = !!remoteHubManager?.isEnabled();
  setupApplicationMenu({ remoteHub: remoteMode ? { open: () => openStatusWindow(false) } : undefined });
}

/** The hub's own web page, in a window with no preload (it talks to its server over http, like a phone) and locked to the hub's origin. */
function createRemoteWindow(origin: string, startHidden = false): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    show: !startHidden,
    icon: path.join(__dirname, '../../../assets/icon.png'),
    backgroundColor: '#0d47a1',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Its own cookie jar, so the hub's sign-in stays across restarts and apart from everything local.
      partition: 'persist:remote-hub',
    },
  });
  remoteWindow = win;
  const contents = win.webContents;
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideNewWindow(origin, url);
    if (decision.kind === 'external') void shell.openExternal(decision.url);
    return { action: 'deny' };
  });
  const guard = (event: Electron.Event, url: string) => {
    const decision = decideNavigation(origin, url);
    if (decision.kind === 'allow') return;
    event.preventDefault();
    if (decision.kind === 'external') void shell.openExternal(decision.url);
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    // -3 is a navigation that was cancelled (by us or by the page); anything else on the main frame means the hub is not there.
    if (isMainFrame && code !== -3 && remoteWindow === win) {
      openStatusWindow(true);
      win.destroy();
    }
  });
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (remoteWindow === win) remoteWindow = null;
  });
  attachContextMenu(win);
  void win.loadURL(origin);
}

/** The small local page: status, allowed folders, send setup, and the way back to this computer's own hub. */
function openStatusWindow(unreachable: boolean): void {
  if (remoteStatusWindow && !remoteStatusWindow.isDestroyed()) {
    void remoteStatusWindow.loadURL(remoteHubPageUrl(unreachable));
    remoteStatusWindow.show();
    remoteStatusWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 700,
    height: 780,
    icon: path.join(__dirname, '../../../assets/icon.png'),
    backgroundColor: '#0d47a1',
    webPreferences: {
      preload: path.join(__dirname, 'remoteHub', 'remoteHubPreload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  remoteStatusWindow = win;
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    if (remoteStatusWindow === win) remoteStatusWindow = null;
  });
  void win.loadURL(remoteHubPageUrl(unreachable));
}

function closeRemoteWindows(): void {
  for (const win of [remoteWindow, remoteStatusWindow]) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  remoteWindow = null;
  remoteStatusWindow = null;
}

/** Shows the hub's page if the hub answers, otherwise the local page with Retry and "Use this computer's own hub". */
async function showRemoteMode(startHidden = false): Promise<void> {
  if (remoteWindow && !remoteWindow.isDestroyed()) {
    remoteWindow.show();
    remoteWindow.focus();
    return;
  }
  const manager = getRemoteHubManager();
  const origin = manager.hubOrigin();
  if (!origin || !(await manager.hubReachable())) {
    if (!startHidden) openStatusWindow(true);
    return;
  }
  if (remoteStatusWindow && !remoteStatusWindow.isDestroyed()) remoteStatusWindow.destroy();
  createRemoteWindow(origin, startHidden);
}

function isOwnLocalPage(event: Electron.IpcMainInvokeEvent): boolean {
  const sender = event.sender;
  return (
    (!!mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) ||
    (!!remoteStatusWindow && !remoteStatusWindow.isDestroyed() && sender === remoteStatusWindow.webContents)
  );
}

async function turnOffRemoteMode(): Promise<void> {
  const manager = getRemoteHubManager();
  await manager.disable(); // stops the worker, deletes the token, brings the local hub back
  closeRemoteWindows();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
  createWindow(false);
  refreshMenu();
}

/** After switching on: offer, once, to send this computer's jobs and mappings to the hub. */
async function offerSetupExport(): Promise<void> {
  const manager = getRemoteHubManager();
  if (manager.state().setupOffered || !db) return;
  const payload = buildSetupPayload(db);
  if (payload.jobs.length === 0 && payload.mappings.length === 0) {
    manager.markSetupOffered();
    return;
  }
  const parent = remoteWindow && !remoteWindow.isDestroyed() ? remoteWindow : undefined;
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Send your setup to the hub?',
    message: `Send this computer's ${payload.jobs.length} job${payload.jobs.length === 1 ? '' : 's'} and ${payload.mappings.length} mapping${payload.mappings.length === 1 ? '' : 's'} to the hub?`,
    detail:
      'They become this machine\'s jobs and mappings on the hub (run history is not sent). Names the hub already has are skipped. Sent jobs are switched off there until you turn them on. Your data here stays as it is, as a backup.\n\nYou can also do this later from View > Remote hub settings.',
    buttons: ['Send', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  };
  const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  manager.markSetupOffered();
  if (answer.response !== 0) return;
  try {
    const report = await manager.sendSetup();
    const skipped = [...report.mappingsSkipped.map((s) => `mapping "${s.name}"`), ...report.jobsSkipped.map((s) => `job "${s.name}"`)];
    await dialog.showMessageBox({
      type: 'info',
      title: 'Setup sent',
      message: `Sent ${report.mappingsSent} mapping${report.mappingsSent === 1 ? '' : 's'} and ${report.jobsSent} job${report.jobsSent === 1 ? '' : 's'}.`,
      detail: skipped.length ? `Skipped: ${skipped.join(', ')}.` : 'Nothing was skipped.',
    });
  } catch (err) {
    await dialog.showMessageBox({ type: 'error', title: 'Could not send the setup', message: err instanceof Error ? err.message : String(err) });
  }
}

function registerRemoteHubIpc(): void {
  const manager = getRemoteHubManager();
  const trusted = <T,>(fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T) => // eslint-disable-line @typescript-eslint/no-explicit-any
    async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isOwnLocalPage(event)) throw new Error('Not allowed from here.');
      return fn(event, ...args);
    };
  handle('remoteHub:getState', trusted(() => manager.state()));
  handle(
    'remoteHub:enable',
    trusted(async (_event, input: RemoteHubEnableInput) => {
      const state = await manager.enable({
        hubUrl: String(input?.hubUrl ?? ''),
        code: String(input?.code ?? ''),
        name: String(input?.name ?? ''),
        allowedFolders: Array.isArray(input?.allowedFolders) ? input.allowedFolders.map(String) : [],
      });
      // This window has the local interface (and its preload); the hub's page gets a plain window of its own.
      const old = mainWindow;
      mainWindow = null;
      await showRemoteMode();
      refreshMenu();
      setTimeout(() => {
        if (old && !old.isDestroyed()) old.destroy();
      }, 0);
      void offerSetupExport();
      return state;
    })
  );
  handle('remoteHub:disable', trusted(async () => {
    await turnOffRemoteMode();
    return manager.state();
  }));
  handle('remoteHub:setAllowedFolders', trusted((_event, folders: string[]) => manager.setAllowedFolders(Array.isArray(folders) ? folders.map(String) : [])));
  handle(
    'remoteHub:pickFolder',
    trusted(async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.OpenDialogOptions = { title: 'Choose a folder this computer lets the hub use', properties: ['openDirectory'] };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    })
  );
  handle(
    'remoteHub:sendSetup',
    trusted(async () => {
      if (!db) {
        db = await initDatabase(); // read-only use: only the export reads it
        repo.migrateChainsToJobs(db);
      }
      return manager.sendSetup();
    })
  );
  handle('remoteHub:markSetupOffered', trusted(() => manager.markSetupOffered()));
  handle(
    'remoteHub:retry',
    trusted(async () => {
      if (!(await manager.hubReachable())) return { problem: 'The hub still cannot be reached.' };
      await showRemoteMode();
      return {};
    })
  );
  handle(
    'remoteHub:useLocal',
    trusted(async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.MessageBoxOptions = {
        type: 'question',
        title: "Use this computer's own hub?",
        message: "Stop using the remote hub and go back to this computer's own jobs?",
        detail: 'The saved token is deleted and this computer\'s own scheduler, phone access and Claude access come back as they were. Nothing is removed on the hub.',
        buttons: ['Use this computer\'s own hub', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      };
      const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (answer.response !== 0) return { cancelled: true };
      await turnOffRemoteMode();
      return {};
    })
  );
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

  const manager = getRemoteHubManager();
  const remoteMode = manager.isEnabled();
  refreshMenu();
  registerRemoteHubIpc();

  // Timers are unreliable across sleep, and files may have landed while the PC
  // was asleep: rebuild the schedules and pick up anything that was missed.
  // Whichever worker is running (this computer's own, or the one serving a remote hub) is told.
  powerMonitor.on('resume', () => {
    workerSystem?.worker.resumeFromSleep();
    remoteHubManager?.running?.runtime.resumeFromSleep();
  });
  app.on('activate', () => {
    if (!appInitialized) return;
    if (BrowserWindow.getAllWindows().length === 0 && !manager.isEnabled()) {
      createWindow(false);
    } else {
      showWindow();
    }
  });

  const configuredDbPath = getConfiguredDbPath();
  // In remote mode this computer's own database is not opened at all, so a missing one is no reason to stop.
  if (!remoteMode && configuredDbPath && !fs.existsSync(configuredDbPath)) {
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
  if (remoteMode) {
    // Launch goes straight to the hub's page. No local database, scheduler, phone server, MCP or retention starts.
    logStartupStep('main: remote hub mode');
    createTray();
    appInitialized = true;
    logStartupStep('main: startup complete');
    try {
      await manager.resumeAtLaunch();
    } catch (err) {
      logStartupStep(`main: remote hub worker did not start: ${err instanceof Error ? err.message : err}`);
    }
    await showRemoteMode(startHidden);
    setupAutoUpdater();
    return;
  }
  // Create the window (showing the loading screen) before the potentially
  // slow work below, so a stalled startup shows *something* instead of
  // nothing at all.
  logStartupStep('main: past configuredDbPath check, creating window');
  createWindow(startHidden);
  logStartupStep('main: window created');

  const logStep = logStartupStep;

  try {
    logStep('main: calling initDatabase()');
    await startLocalHub();
    logStep('main: local hub started, loading app content');
    if (mainWindow) loadAppContent(mainWindow);
    createTray();
    appInitialized = true;
    logStep('main: startup complete');
    announceDatabaseRecovery();
    setupAutoUpdater();

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
  remoteHubManager?.shutdown();
  retention?.shutdown();
  void remote?.shutdown();
  if (db) flushDatabase(db);
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
});
