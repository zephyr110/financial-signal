'use strict';
const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { importDbFile } = require('./import-db');

function registerIpc({ getConfigFile, getDbPath, onImported, onFetchNow }) {
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
    if (r.ok && onImported) onImported();
    return r;
  });

  ipcMain.handle('app:open-data-dir', () => {
    shell.openPath(path.dirname(getDbPath()));
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
