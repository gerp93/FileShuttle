import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge for the small local "Remote hub" page only. The hub's own web page is loaded in a
 * different window with no preload at all.
 */
const api = {
  getState: () => ipcRenderer.invoke('remoteHub:getState'),
  setAllowedFolders: (folders: string[]) => ipcRenderer.invoke('remoteHub:setAllowedFolders', folders),
  pickFolder: () => ipcRenderer.invoke('remoteHub:pickFolder'),
  sendSetup: () => ipcRenderer.invoke('remoteHub:sendSetup'),
  retry: () => ipcRenderer.invoke('remoteHub:retry'),
  useLocal: () => ipcRenderer.invoke('remoteHub:useLocal'),
};

contextBridge.exposeInMainWorld('remoteHubAPI', api);
