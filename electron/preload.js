'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  selectAndImportDb: () => ipcRenderer.invoke('app:select-and-import-db'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  fetchNow: () => ipcRenderer.invoke('app:fetch-now'),
});
