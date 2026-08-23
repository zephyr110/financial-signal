'use strict';
const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { importDbFile } = require('./import-db');

// 串行化:连续两次 db 变更(导入/全新创建)都会重启 server(停旧→启新),
// 依次执行避免并发 stop/start 交错导致 start 抛错 → app.quit 或孤儿 standalone 进程。
let importChain = Promise.resolve();

/** 把一次"重启 server"的 db 变更排队到串行链上执行;invoke 在完成后才 resolve。 */
function enqueueRestart(task, label) {
  const p = importChain
    .then(task)
    .catch((e) => {
      console.error(`[main] ${label} restart failed:`, e);
      return { ok: false, error: `${label} 重启失败: ${e.message}` };
    });
  importChain = p.catch(() => {});
  return p;
}

function registerIpc({ getDbPath, onImported, onFreshDb, onFetchNow }) {
  ipcMain.handle('app:select-and-import-db', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择要导入的 news_archive.db',
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    const src = filePaths[0];
    const dest = getDbPath();
    const r = await importDbFile(src, dest);
    if (r.ok && onImported) {
      await enqueueRestart(() => onImported(), 'import');
    }
    return r;
  });

  ipcMain.handle('app:create-fresh-db', async () => {
    if (!onFreshDb) return { ok: false, error: '桌面功能不可用' };
    const r = await enqueueRestart(() => onFreshDb(), 'fresh-db');
    return r || { ok: true };
  });

  ipcMain.handle('app:open-data-dir', async () => {
    const err = await shell.openPath(path.dirname(getDbPath()));
    return { ok: !err, error: err || undefined };
  });

  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    dbPath: getDbPath(),
    imported: fs.existsSync(getDbPath()),
  }));

  ipcMain.handle('app:fetch-now', async () => {
    if (onFetchNow) await onFetchNow();
    return { ok: true };
  });
}

module.exports = { registerIpc };
