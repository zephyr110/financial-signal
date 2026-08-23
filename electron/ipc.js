'use strict';
const { ipcMain, dialog, shell, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { importDbFile, validateDbFile } = require('./import-db');

const isDev = !app.isPackaged;

// 串行化:连续两次 db 变更(导入/全新创建)都会重启 server(停旧→启新),
// 依次执行避免并发 stop/start 交错导致 start 抛错 → app.quit 或孤儿 standalone 进程。
let importChain = Promise.resolve();

/**
 * 把一次"重启 server"的 db 变更排队到串行链上执行;invoke 在完成后才 resolve。
 * 任务失败时返回的 promise 保持 reject(不吞错),由调用方 handler 转成 {ok:false} 响应,
 * 避免渲染层误以为导入成功;importChain 本身用 catch 兜底记日志,保证后续 db 变更仍能排队执行。
 */
function enqueueRestart(task, label) {
  const p = importChain.then(task);
  importChain = p.catch((e) => {
    console.error(`[main] ${label} restart failed:`, e);
  });
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
      try {
        await enqueueRestart(() => onImported(), 'import');
      } catch (e) {
        // restartAfterDbChange 失败(server 重启失败)时主进程会 app.quit,
        // 但仍要返回 {ok:false},渲染层才不会误以为导入成功
        return { ok: false, error: `数据库已导入,但服务重启失败: ${e.message}` };
      }
    }
    return r;
  });

  ipcMain.handle('app:create-fresh-db', async () => {
    if (!onFreshDb) return { ok: false, error: '桌面功能不可用' };
    try {
      const r = await enqueueRestart(() => onFreshDb(), 'fresh-db');
      return r || { ok: true };
    } catch (e) {
      return { ok: false, error: `数据库已创建,但服务重启失败: ${e.message}` };
    }
  });

  ipcMain.handle('app:open-data-dir', async () => {
    const err = await shell.openPath(path.dirname(getDbPath()));
    return { ok: !err, error: err || undefined };
  });

  ipcMain.handle('app:get-info', async () => {
    const dbPath = getDbPath();
    // prod:db 存在且含必要表才算导入完成(防 0 字节/未初始化空库把欢迎页跳过)
    // dev:userData 的 db 只有 createFreshDb 会碰,existsSync 足够,且 dev 无 server 建表
    const imported = isDev
      ? fs.existsSync(dbPath)
      : (await validateDbFile(dbPath)).ok;
    return { version: app.getVersion(), dbPath, imported };
  });

  ipcMain.handle('app:fetch-now', async () => {
    if (onFetchNow) await onFetchNow();
    return { ok: true };
  });
}

module.exports = { registerIpc };
