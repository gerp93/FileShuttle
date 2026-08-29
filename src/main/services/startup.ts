import { app } from 'electron';

export const isStartupSupported = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';

export function isStartupEnabled(): boolean {
  if (!isStartupSupported) return false;
  return app.getLoginItemSettings().openAtLogin;
}

export function setStartupEnabled(enabled: boolean): void {
  if (!isStartupSupported) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: process.platform === 'win32' ? ['--start-hidden'] : undefined,
  });
}
