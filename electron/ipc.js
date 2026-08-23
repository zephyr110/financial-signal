'use strict';
const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { importDbFile } = require('./import-db');

// 导入串行化:连续两次导入时,onImported(停旧 server→启动新 server)依次执行,
// 避免并发 stop/start 交错导致 start 抛错 → app.quit 或孤儿 standalone 进程。
let importChain = Promise.resolve();

function registerIpc({ getDbPath, onImported, onFetchNow }) {
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
      const p = importChain
        .then(() => onImported())
        .catch((e) => console.error('[main] import restart failed:', e));
      importChain = p.catch(() => {});
      await p; // invoke 在 server 重启完成后才 resolve
    }
    return r;
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
