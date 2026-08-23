'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer, devUrl, stopServer } = require('./server');
const { createScheduler } = require('./scheduler');

let mainWindow = null;
let serverUrl = null;
let scheduler = null;

const isDev = !app.isPackaged;
const userData = app.getPath('userData');
const dbPath = path.join(userData, 'news_archive.db');
const configFile = path.join(userData, 'config.json');

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

function navigate() {
  if (!mainWindow) return;
  mainWindow.loadURL(serverUrl || devUrl()).catch(() => {
    setTimeout(navigate, 500);
  });
}

async function startScheduler() {
  if (!serverUrl || scheduler) return;
  scheduler = createScheduler({
    baseUrl: serverUrl,
    dbPath,
    configFile,
    onRunStart: (sequence) => console.log(`[scheduler] run: ${sequence.join(' → ')}`),
  });
  scheduler.start();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const url = isDev ? devUrl() : await startServer({
        dbPath,
        // 崩溃重启后端口变化,用新 URL 重新导航
        onCrash: (nextUrl) => { serverUrl = nextUrl; navigate(); },
      });
      serverUrl = url;
      createWindow();
      navigate();
      if (!isDev) startScheduler();
    } catch (err) {
      console.error('[main] failed to start server:', err.message);
      app.quit();
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        navigate();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 退出前停掉 standalone 子进程(避免残留 node 进程)
  app.on('will-quit', () => {
    stopServer();
  });
}
