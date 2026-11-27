/**
 * Web mode: the page is open in a phone's browser, not in the Electron window. main.tsx decides
 * once at startup (no `window.fileshuttleAPI` means no Electron preload) and everything else asks here.
 */
let webMode = false;

export function markWebMode(): void {
  webMode = true;
}

export function isWebMode(): boolean {
  return webMode;
}
