'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const DEV_URL = 'http://127.0.0.1:3010';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Financial Signal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function loadUrlWithRetry(url, attempts = 60) {
  createWindow();
  const tryLoad = (n) => {
    if (!mainWindow) return;
    mainWindow.loadURL(url).catch(() => {
      if (n > 0) setTimeout(() => tryLoad(n - 1), 500);
    });
  };
  tryLoad(attempts);
}

app.whenReady().then(() => {
  loadUrlWithRetry(DEV_URL);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) loadUrlWithRetry(DEV_URL);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
