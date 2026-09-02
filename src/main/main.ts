import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, Notification, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { Database } from 'sql.js';
import { initDatabase, saveDatabase } from './database/schema';
import * as repo from './database/repository';
import {
  getEffectiveDbPath,
  getDefaultDbPath,
  isUsingDefaultLocation,
  setDbPath,
  resetToDefaultDbPath,
} from './dbLocation';
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

app.setName('fileshuttle');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: Database | null = null;
let scheduler: SchedulerService | null = null;
let watcher: WatcherService | null = null;
let retention: RetentionService | null = null;
let announcedBackground = false;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
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

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
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
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an existing FileShuttle database file',
      properties: ['openFile'],
      filters: [{ name: 'SQLite Database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('dbLocation:browseNew', async () => {
    if (!mainWindow) return null;
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
  const startHidden = process.argv.includes('--start-hidden');
  db = await initDatabase();
  repo.migrateChainsToJobs(db);
  saveDatabase(db);

  retention = new RetentionService(db);
  retention.start();

  scheduler = new SchedulerService(db, (jobId, result) => {
    const job = repo.getJob(db!, jobId);
    const jobName = job?.name ?? `job #${jobId}`;
    showTrayNotification('FileShuttle: scheduled run finished', `"${jobName}" — ${summarizeResult(result)}`);
  });

  watcher = new WatcherService(db, (jobId, result) => {
    const job = repo.getJob(db!, jobId);
    const jobName = job?.name ?? `job #${jobId}`;
    showTrayNotification('FileShuttle: watched folder run finished', `"${jobName}" — ${summarizeResult(result)}`);
  });

  registerIPCHandlers();
  createWindow(startHidden);
  createTray();
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
