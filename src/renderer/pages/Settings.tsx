import { useEffect, useState } from 'react';
import { DEFAULT_LOG_RETENTION, LOG_RETENTION_PRESETS, LogRetentionId } from '../../shared/types';
import { useTheme } from '../context/ThemeContext';
import { FletThemeId, getThemeList } from '../utils/themes';

export default function Settings() {
  const { themeId, setThemeId } = useTheme();
  const [dbPath, setDbPath] = useState('');
  const [isDefaultDb, setIsDefaultDb] = useState(true);
  const [startupSupported, setStartupSupported] = useState(false);
  const [startupEnabled, setStartupEnabled] = useState(false);
  const [logRetention, setLogRetention] = useState<LogRetentionId>(DEFAULT_LOG_RETENTION);
  const [updateStatus, setUpdateStatus] = useState('');
  const [confirmRelocate, setConfirmRelocate] = useState<{ message: string; action: () => Promise<void> } | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purging, setPurging] = useState(false);
  const [snackbar, setSnackbar] = useState('');
  const [version, setVersion] = useState('');

  useEffect(() => {
    void window.fileshuttleAPI.dbLocation.get().then((info) => {
      setDbPath(info.path);
      setIsDefaultDb(info.isDefault);
    });
    void window.fileshuttleAPI.settings.getStartup().then((s) => {
      setStartupSupported(s.supported);
      setStartupEnabled(s.enabled);
    });
    void window.fileshuttleAPI.app.getVersion().then(setVersion);
    const getLogRetention = window.fileshuttleAPI.settings.getLogRetention;
    if (typeof getLogRetention === 'function') {
      void getLogRetention().then(setLogRetention);
    }
  }, []);

  const changeLogRetention = async (id: LogRetentionId) => {
    setLogRetention(id);
    const result = await window.fileshuttleAPI.settings.setLogRetention(id);
    if (result.deletedRuns > 0) {
      const noun = result.deletedRuns === 1 ? 'run log' : 'run logs';
      setSnackbar(`Removed ${result.deletedRuns} ${noun} outside the new window.`);
    }
  };

  const purgeAllLogs = async () => {
    setConfirmPurge(false);
    setPurging(true);
    try {
      const result = await window.fileshuttleAPI.history.purgeAll();
      if (result.deletedRuns === 0) {
        setSnackbar('No run logs to purge.');
      } else {
        const noun = result.deletedRuns === 1 ? 'run log' : 'run logs';
        setSnackbar(`Purged ${result.deletedRuns} ${noun}.`);
      }
    } finally {
      setPurging(false);
    }
  };

  const confirmAndRelocate = (message: string, action: () => Promise<void>) => {
    setConfirmRelocate({ message, action });
  };

  const useExistingDb = async () => {
    const chosen = await window.fileshuttleAPI.dbLocation.browseExisting();
    if (!chosen) return;
    confirmAndRelocate(`FileShuttle will restart and use the database at:\n${chosen}`, async () => {
      await window.fileshuttleAPI.dbLocation.set(chosen);
    });
  };

  const moveDb = async () => {
    const chosen = await window.fileshuttleAPI.dbLocation.browseNew();
    if (!chosen) return;
    confirmAndRelocate(`FileShuttle will copy the current database to:\n${chosen}\nand restart.`, async () => {
      await window.fileshuttleAPI.dbLocation.set(chosen);
    });
  };

  const resetDb = () => {
    confirmAndRelocate('FileShuttle will restart and use the default database location.', async () => {
      await window.fileshuttleAPI.dbLocation.resetToDefault();
    });
  };

  const checkUpdate = async () => {
    const result = await window.fileshuttleAPI.updates.check();
    if (result.status === 'unsupported') {
      setUpdateStatus('Up to date (or running from source — update checks only apply to packaged builds).');
    } else if (result.status === 'available') {
      setUpdateStatus(`Update available: ${result.version ?? 'unknown version'}`);
    } else if (result.status === 'not-available') {
      setUpdateStatus('Up to date.');
    } else {
      setUpdateStatus(result.message ?? 'Update check failed.');
    }
  };

  return (
    <div>
      <h1 className="page-title">Settings</h1>

      <h2 style={{ fontSize: 16 }}>Startup &amp; Background</h2>
      <div className="switch-row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          id="startup"
          checked={startupEnabled}
          disabled={!startupSupported}
          onChange={(e) => {
            setStartupEnabled(e.target.checked);
            void window.fileshuttleAPI.settings.setStartup(e.target.checked);
          }}
        />
        <label htmlFor="startup">Start FileShuttle when Windows starts</label>
      </div>
      <p className="muted">
        Closing this window keeps FileShuttle running in the background (system tray)
        so scheduled mappings keep firing. Use the tray icon to reopen the window or quit.
      </p>
      {!startupSupported && (
        <p className="muted">Start-at-login isn&apos;t supported on this platform yet.</p>
      )}

      <hr className="divider" />

      <h2 style={{ fontSize: 16 }}>Appearance</h2>
      <label className="field" style={{ marginBottom: 16 }}>
        Theme
        <select value={themeId} onChange={(e) => void setThemeId(e.target.value as FletThemeId)}>
          {getThemeList().map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </label>

      <hr className="divider" />

      <h2 style={{ fontSize: 16 }}>History Retention</h2>
      <label className="field" style={{ marginBottom: 8 }}>
        Keep run logs for
        <select
          value={logRetention}
          onChange={(e) => void changeLogRetention(e.target.value as LogRetentionId)}
        >
          {LOG_RETENTION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.label}</option>
          ))}
        </select>
      </label>
      <p className="muted">
        Old run logs are removed when FileShuttle starts and once a day at midnight
        while it is running. A history entry is written each time logs are purged.
        Choose &quot;Never delete&quot; to keep everything.
      </p>
      <button className="outline danger" disabled={purging} onClick={() => setConfirmPurge(true)}>
        Purge All Logs Now
      </button>

      <hr className="divider" />

      <h2 style={{ fontSize: 16 }}>Database Location</h2>
      <p className="muted" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{dbPath}</p>
      {isDefaultDb && <p className="muted">Using default location.</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="outline" onClick={() => void useExistingDb()}>Use Existing Database File</button>
        <button className="outline" onClick={() => void moveDb()}>Move Database To New Location</button>
        <button className="outline" onClick={resetDb}>Reset to Default Location</button>
      </div>

      <hr className="divider" />

      <h2 style={{ fontSize: 16 }}>Updates</h2>
      <p className="muted">Version {version}</p>
      <button className="outline" onClick={() => void checkUpdate()}>Check for Updates</button>
      {updateStatus && <p className="muted">{updateStatus}</p>}

      {confirmPurge && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Purge all run logs?</h3>
            <p>
              This permanently deletes every job and mapping run from History.
              A single log entry will be kept recording that the purge happened.
            </p>
            <div className="dialog-actions">
              <button className="outline" onClick={() => setConfirmPurge(false)}>Cancel</button>
              <button className="primary" onClick={() => void purgeAllLogs()}>Purge All</button>
            </div>
          </div>
        </div>
      )}

      {confirmRelocate && (
        <div className="dialog-overlay">
          <div className="dialog">
            <h3>Restart required</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{confirmRelocate.message}</p>
            <div className="dialog-actions">
              <button className="outline" onClick={() => setConfirmRelocate(null)}>Cancel</button>
              <button className="primary" onClick={() => void confirmRelocate.action()}>Continue</button>
            </div>
          </div>
        </div>
      )}

      {snackbar && (
        <div className="snackbar" onClick={() => setSnackbar('')}>{snackbar}</div>
      )}
    </div>
  );
}
