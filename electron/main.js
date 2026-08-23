'use strict';
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createClient } = require('./libsql-client');
const { createServerManager, devUrl } = require('./server');
const { createScheduler } = require('./scheduler');
const { createTray } = require('./tray');
const { registerIpc } = require('./ipc');
const { notifyNewHighSignals } = require('./notifier');
const { initUpdater } = require('./updater');

// Windows 通知依赖 AppUserModelID(与 electron-builder appId 一致,缺失则托盘通知
// 静默不显示)。须在 whenReady 之前调用;mac/Linux 上是 no-op,安全。
app.setAppUserModelId('com.zephyr.financial-signal');

let mainWindow = null;
let serverUrl = null;
let scheduler = null;
let serverManager = null;
let tray = null;
// will-quit 后置位:阻止导入链在退出过程中重新拉起 server(幽灵子进程)。
let appQuitting = false;

const isDev = !app.isPackaged;
const userData = app.getPath('userData');
// dev 下 next dev 的 server 落在仓库根 news_archive.db(lib/db.ts 无
// NEWS_DB_PATH 时的 fallback);主进程也指向同一文件,避免 dev 双库分裂
// (设置写仓库库、调度器读 userData 库 → LLM 配置永远"未配置")。
const dbPath = isDev
  ? path.join(process.cwd(), 'news_archive.db')
  : path.join(userData, 'news_archive.db');
const configFile = path.join(userData, 'config.json');

/** 停掉并丢弃调度器(3 处共用:启动替换、换库重启、崩溃后重建)。 */
function stopScheduler() {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}

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
  stopScheduler();
  ensureScheduler();
  scheduler.start();
}

/** 首次启动尚无 db 时不要启动调度器(管线会因缺表失败);真正防止建库的是
 * /api/health 在文件缺失时不触发 getDb(见 pages/api/health.ts)。用户做出
 * 选择后 restartAfterDbChange 内会无条件 startScheduler()(此时 db 必已存在)。 */
function maybeStartScheduler() {
  if (!isDev && fs.existsSync(dbPath)) startScheduler();
}

/** 手动抓取:prod 走调度器 runOnce;dev 无调度器轮询,也建实例按需跑一轮。 */
async function runFetchNow() {
  const r = await ensureScheduler().runOnce();
  if (r === 'running') console.log('[main] fetch now skipped: 上一轮仍在运行');
}

/** db 变更(导入/全新创建)后:旧 server 的 db 句柄失效,必须重启 server 与调度器。 */
async function restartAfterDbChange() {
  if (appQuitting) {
    console.log('[main] quitting, skip server restart');
    return;
  }
  stopScheduler();
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
      // 重启失败要抛给调用方(ipc.js enqueueRestart 会转成 {ok:false} 响应给渲染层),
      // 否则导入/全新创建 handler 会误报成功;app.quit 行为保留
      console.error('[main] failed to restart server after db change:', err.message);
      app.quit();
      throw err;
    }
  }
  navigate();
  if (!isDev) startScheduler();
}

/** db 导入成功后重启内置 server(旧句柄指向被原子替换前的 inode)。 */
async function onImported() {
  await restartAfterDbChange();
}

/** 全新开始:userData 下创建空 db 文件(表结构由 server 启动时 lib/db.ts initSchema 补齐)。 */
async function createFreshDb() {
  if (appQuitting) return { ok: false, error: '应用正在退出' };
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await client.execute('SELECT 1'); // 触建文件
    } finally {
      await client.close();
    }
  } catch (err) {
    return { ok: false, error: `创建数据库失败: ${err.message}` };
  }
  await restartAfterDbChange();
  return { ok: true };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 单实例锁在 whenReady 之前生效,极早期(win 双击启动时)可能先于 ready
    // 收到 second-instance → 此时建窗口抛 "Cannot create BrowserWindow
    // before app is ready" → 未捕获异常杀死正在启动的主进程。
    if (!app.isReady()) return;
    showMainWindow();
  });

  app.whenReady().then(async () => {
    try {
      if (!isDev) {
        // 仅打包版自动更新:启动静默检查一次(托盘手动检查在 createTray 里接上)
        initUpdater();
        serverManager = createServerManager({
          spawn,
          dbPath,
          // 崩溃重启后端口变化:更新 serverUrl、重新导航、重建调度器(绑新端口)
          onCrash: (nextUrl) => {
            serverUrl = nextUrl;
            navigate();
            maybeStartScheduler();
          },
          // 重启 5 次仍无法恢复:standalone 不可用,弹窗说明后退出,
          // 而不是无提示闪退(用户无从得知原因/数据目录)
          onGiveUp: () => {
            console.error('[app] standalone server failed to recover, quitting');
            dialog.showMessageBoxSync({
              type: 'error',
              title: '服务启动失败',
              message: '内置服务多次启动失败,应用将退出。\n\n可尝试:检查数据目录,或重新安装应用。',
            });
            app.quit();
          },
        });
      }
      createWindow(); // 先出窗口壳:server 启动(2-5s)期间不阻塞首帧渲染
      const url = isDev ? devUrl() : await serverManager.start();
      serverUrl = url;
      navigate();
      // 首次启动尚无 db 时不启动调度器(管线会因缺表失败);欢迎页门控由
      // /api/health 在 db 缺失时不触发 getDb 保证——服务端抢先建库的根源
      // 已被切断(见 pages/api/health.ts)。用户做出选择(导入/全新开始)后
      // restartAfterDbChange 内会无条件 startScheduler()(此时 db 必已存在)。
      maybeStartScheduler();
      registerIpc({
        getDbPath: () => dbPath,
        onImported,
        onFreshDb: createFreshDb,
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
          onCheckUpdate: () => initUpdater({ manual: true }),
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
      dialog.showMessageBoxSync({
        type: 'error',
        title: '启动失败',
        message: `内置服务启动失败: ${err.message}`,
      });
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
    appQuitting = true;
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
