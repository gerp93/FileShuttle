import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, Notification, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { Database } from 'sql.js';
import { initDatabase, saveDatabase } from './database/schema';
import * as repo from './database/repository';
import {
  pinUserDataPath,
  getConfiguredDbPath,
  getEffectiveDbPath,
  getDefaultDbPath,
  isUsingDefaultLocation,
  setDbPath,
  resetToDefaultDbPath,
} from './dbLocation';
import { logStartupStep, resetStartupLog } from './startupLog';
import { attachContextMenu, setupApplicationMenu } from './menu';
import { executeAllEnabledJobs, executeJob, executeUndo } from './services/runService';
import { applyRetention, getLogRetention, RetentionService, setLogRetention } from './services/retention';
import { isStartupEnabled, isStartupSupported, setStartupEnabled } from './services/startup';
import { SchedulerService } from './scheduler/scheduler';
import { WatcherService } from './scheduler/watcher';
import {
  CreateJobInput,
  CreateMappingInput,
  HistoryListFilter,
  LogRetentionId,
  RunAllSummary,
  RunResult,
  UpdateCheckResult,
  UpdateJobInput,
  UpdateMappingInput,
} from '../shared/types';

pinUserDataPath();
app.setName('fileshuttle');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: Database | null = null;
let scheduler: SchedulerService | null = null;
let watcher: WatcherService | null = null;
let retention: RetentionService | null = null;
let announcedBackground = false;
let isQuitting = false;
// Guards against a real race: if a second launch attempt's 'second-instance'
// event lands while this process is still awaiting initDatabase() (loading
// the sql.js WASM engine takes a moment), showWindow() would see mainWindow
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

function summarizeResult(result: RunResult): string {
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
          scheduler?.shutdown();
          watcher?.shutdown();
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

function registerIPCHandlers(): void {
  ipcMain.handle('mappings:list', () => {
    return repo.listMappings(db!);
  });

  ipcMain.handle('mappings:get', (_, id: number) => repo.getMapping(db!, id));

  ipcMain.handle('mappings:create', (_, input: CreateMappingInput) => {
    const id = repo.createMapping(db!, input);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
    return id;
  });

  ipcMain.handle('mappings:update', (_, id: number, input: UpdateMappingInput) => {
    repo.updateMapping(db!, id, input);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
  });

  ipcMain.handle('mappings:delete', (_, id: number) => {
    repo.deleteMapping(db!, id);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
  });

  ipcMain.handle('mappings:clone', (_, id: number, name: string) => {
    const newId = repo.cloneMapping(db!, id, name);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
    return newId;
  });

  ipcMain.handle('mappings:listJobsUsing', (_, id: number) => repo.listJobsUsingMapping(db!, id));

  ipcMain.handle('mappings:setEnabled', (_, id: number, enabled: boolean) => {
    repo.setMappingEnabled(db!, id, enabled);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
  });

  ipcMain.handle('mappings:getStats', (_, id: number) => repo.getRunStats(db!, id));

  ipcMain.handle('jobs:list', () => repo.listJobs(db!));

  ipcMain.handle('jobs:get', (_, id: number) => repo.getJob(db!, id));

  ipcMain.handle('jobs:create', (_, input: CreateJobInput) => {
    const id = repo.createJob(db!, input);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
    return id;
  });

  ipcMain.handle('jobs:update', (_, id: number, input: UpdateJobInput) => {
    repo.updateJob(db!, id, input);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
  });

  ipcMain.handle('jobs:delete', (_, id: number) => {
    repo.deleteJob(db!, id);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
  });

  ipcMain.handle('jobs:setEnabled', (_, id: number, enabled: boolean) => {
    repo.setJobEnabled(db!, id, enabled);
    saveDatabase(db!);
    scheduler?.reloadJobs();
    watcher?.reloadJobs();
  });

  ipcMain.handle('jobs:getStats', (_, id: number) => repo.getJobStats(db!, id));

  ipcMain.handle('jobs:run', async (_, id: number): Promise<RunResult> => {
    return executeJob(db!, id, 'manual');
  });

  ipcMain.handle('jobs:runAll', async (): Promise<RunAllSummary> => {
    const results = await executeAllEnabledJobs(db!, 'manual');
    return {
      jobCount: results.length,
      mappingCount: results.reduce((sum, r) => sum + r.fileOutcomes.length, 0),
      filesMoved: results.reduce((sum, r) => sum + r.filesMoved, 0),
      filesSkipped: results.reduce((sum, r) => sum + r.filesSkipped, 0),
      filesErrored: results.reduce((sum, r) => sum + r.filesErrored, 0),
    };
  });

  ipcMain.handle('history:list', (_, filter?: HistoryListFilter | number | null) => repo.listRuns(db!, filter));

  ipcMain.handle('history:getDetail', (_, runId: number) => repo.getRunDetail(db!, runId));

  ipcMain.handle('history:undo', async (_, runId: number) => executeUndo(db!, runId));

  ipcMain.handle('history:purgeAll', () => applyRetention(db!, 'all'));

  ipcMain.handle('settings:getTheme', () => repo.getSetting(db!, 'theme', 'blue_oval'));

  ipcMain.handle('settings:setTheme', (_, themeId: string) => {
    repo.setSetting(db!, 'theme', themeId);
    saveDatabase(db!);
  });

  ipcMain.handle('settings:getStartup', () => ({
    supported: isStartupSupported,
    enabled: isStartupEnabled(),
  }));

  ipcMain.handle('settings:setStartup', (_, enabled: boolean) => {
    setStartupEnabled(enabled);
  });

  ipcMain.handle('settings:getLogRetention', () => getLogRetention(db!));

  ipcMain.handle('settings:setLogRetention', (_, id: LogRetentionId) => {
    setLogRetention(db!, id);
    return applyRetention(db!, 'expired');
  });

  ipcMain.handle('dialogs:pickFolder', async (_, title: string) => {
    if (!mainWindow) return null;
    mainWindow.focus();
    const result = await dialog.showOpenDialog(mainWindow, {
      title,
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
    if (db) saveDatabase(db);
    setDbPath(newPath);
    app.relaunch();
    app.exit();
    return { success: true };
  });

  ipcMain.handle('dbLocation:resetToDefault', () => {
    if (db) saveDatabase(db);
    resetToDefaultDbPath();
    app.relaunch();
    app.exit();
    return { success: true };
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('updates:check', () => checkForUpdatesNow());
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

  logStep('main: calling initDatabase()');
  db = await initDatabase();
  logStep('main: initDatabase() returned, calling migrateChainsToJobs()');
  repo.migrateChainsToJobs(db);
  logStep('main: migrateChainsToJobs() done, calling saveDatabase()');
  saveDatabase(db);
  logStep('main: saveDatabase() done, starting retention service');

  retention = new RetentionService(db);
  retention.start();
  logStep('main: retention started, constructing scheduler');

  scheduler = new SchedulerService(db, (jobId, result) => {
    const job = repo.getJob(db!, jobId);
    const jobName = job?.name ?? `job #${jobId}`;
    showTrayNotification('FileShuttle: scheduled run finished', `"${jobName}" — ${summarizeResult(result)}`);
  });
  logStep('main: scheduler constructed, constructing watcher');

  watcher = new WatcherService(db, (jobId, result) => {
    const job = repo.getJob(db!, jobId);
    const jobName = job?.name ?? `job #${jobId}`;
    showTrayNotification('FileShuttle: watched folder run finished', `"${jobName}" — ${summarizeResult(result)}`);
  });
  logStep('main: watcher constructed, registering IPC handlers');

  registerIPCHandlers();
  logStep('main: IPC handlers registered, loading app content');
  if (mainWindow) loadAppContent(mainWindow);
  createTray();
  appInitialized = true;
  logStep('main: startup complete');
  scheduler.start();
  watcher.start();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(false);
    } else {
      showWindow();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.shutdown();
  watcher?.shutdown();
  retention?.shutdown();
  if (db) saveDatabase(db);
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
});
