import { contextBridge, ipcRenderer } from 'electron';

/**
 * The preload of the small local "Remote hub" page only (never of the hub's own page, which gets none).
 * It exposes exactly the calls that page makes; the main process also checks the sender of each one.
 */
contextBridge.exposeInMainWorld('remoteHubAPI', {
  getState: () => ipcRenderer.invoke('remoteHub:getState'),
  retry: () => ipcRenderer.invoke('remoteHub:retry'),
  setAllowedFolders: (folders: string[]) => ipcRenderer.invoke('remoteHub:setAllowedFolders', folders),
  pickFolder: () => ipcRenderer.invoke('remoteHub:pickFolder'),
  sendSetup: () => ipcRenderer.invoke('remoteHub:sendSetup'),
  useLocal: () => ipcRenderer.invoke('remoteHub:useLocal'),
});
