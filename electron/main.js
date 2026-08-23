'use strict';
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createServerManager, devUrl } = require('./server');
const { createScheduler } = require('./scheduler');
const { createTray } = require('./tray');
const { registerIpc } = require('./ipc');
const { notifyNewHighSignals } = require('./notifier');

let mainWindow = null;
let serverUrl = null;
let scheduler = null;
let serverManager = null;
let tray = null;

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

/** 唤起主窗口:不存在则重建;最小化先 restore;统一 4 处唤起逻辑。 */
function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    navigate();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function navigate() {
  if (!mainWindow) return;
  mainWindow.loadURL(serverUrl || devUrl()).catch(() => {
    setTimeout(navigate, 500);
  });
}

/** 保证调度器存在(dev 下仅按需 runOnce,不 start 定时轮询)。 */
function ensureScheduler() {
  if (scheduler) return scheduler;
  scheduler = createScheduler({
    baseUrl: serverUrl || devUrl(),
    dbPath,
    configFile,
    onRunStart: (sequence) => console.log(`[scheduler] run: ${sequence.join(' → ')}`),
    onRunEnd: () => {
      // 通知失败不能打断调度循环,吞掉错误只记日志
      notifyNewHighSignals({
        dbPath,
        configFile,
        onActivate: showMainWindow,
      }).catch((err) => console.error('[notifier] notify failed:', err.message));
    },
  });
  return scheduler;
}

async function startScheduler() {
  if (!serverUrl) return;
  // 幂等:已存在则先停再建(崩溃重启后端口变化,调度器必须绑新 URL)
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
  ensureScheduler();
  scheduler.start();
}

/** 手动抓取:prod 走调度器 runOnce;dev 无调度器轮询,也建实例按需跑一轮。 */
async function runFetchNow() {
  await ensureScheduler().runOnce();
}

/** db 导入成功后:旧 server 的 db 句柄指向旧 inode,必须重启 server 与调度器。 */
async function onImported() {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
  if (serverManager) {
    try {
      serverManager.stop();
    } catch (err) {
      console.error('[main] stop server failed:', err.message);
    }
    serverUrl = null;
    try {
      serverUrl = await serverManager.start();
    } catch (err) {
      console.error('[main] failed to restart server after db import:', err.message);
      app.quit();
      return;
    }
  }
  navigate();
  if (!isDev) startScheduler();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    try {
      if (!isDev) {
        serverManager = createServerManager({
          spawn,
          dbPath,
          // 崩溃重启后端口变化:更新 serverUrl、重新导航、重建调度器(绑新端口)
          onCrash: (nextUrl) => {
            serverUrl = nextUrl;
            navigate();
            startScheduler();
          },
          // 重启 5 次仍无法恢复:standalone 不可用,退出应用而不是静默瘫痪
          onGiveUp: () => {
            console.error('[app] standalone server failed to recover, quitting');
            app.quit();
          },
        });
      }
      const url = isDev ? devUrl() : await serverManager.start();
      serverUrl = url;
      createWindow();
      navigate();
      if (!isDev) startScheduler();
      registerIpc({
        getDbPath: () => dbPath,
        onImported,
        onFetchNow: runFetchNow,
      });
      try {
        tray = createTray({
          onOpen: showMainWindow,
          onFetchNow: runFetchNow,
          onOpenDataDir: () => {
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
            shell.openPath(path.dirname(dbPath));
          },
          // onCheckUpdate 留空:自动更新是 Task 12
          onQuit: () => {
            app.quit();
          },
        });
      } catch (err) {
        // 托盘失败(图标缺失等)不应阻止应用运行
        console.error('[main] failed to create tray:', err.message);
      }
    } catch (err) {
      console.error('[main] failed to start server:', err.message);
      app.quit();
    }
    app.on('activate', () => {
      showMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 退出前停掉 standalone 子进程、销毁托盘(避免残留 node 进程/常驻图标)
  app.on('will-quit', () => {
    if (serverManager) serverManager.stop();
    if (tray) {
      try {
        tray.destroy();
      } catch (err) {
        // Linux 上 destroy 有已知问题,失败不应阻止退出
        console.error('[main] failed to destroy tray:', err.message);
      }
    }
  });
}
