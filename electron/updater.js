'use strict';
const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');

let checkedOnce = false;
// 监听器只注册一次:initUpdater 会被调用两次(启动静默 + 托盘手动),
// 重复注册会让同一事件(update-available/update-downloaded)触发两遍——
// 弹两次窗、downloadUpdate/quitAndInstall 执行两次。手动/静默的差异由
// 当前检查模式(manualMode)决定:手动检查弹窗确认,静默检查后台下载。
let listenersRegistered = false;
let manualMode = false;

/** 启动后静默检查一次;托盘手动检查会弹进度。 */
function initUpdater({ manual = false } = {}) {
  autoUpdater.autoDownload = false;
  if (!listenersRegistered) {
    listenersRegistered = true;
    autoUpdater.on('update-available', async (info) => {
      try {
        if (manualMode) {
          const { response } = await dialog.showMessageBox({
            type: 'info',
            buttons: ['下载', '稍后'],
            defaultId: 0,
            message: `发现新版本 ${info.version}`,
          });
          if (response !== 0) return;
        }
        // downloadUpdate 失败会同时 dispatch 'error' 并 reject;不捕获的话
        // async 监听器的 rejection 无人理会 → unhandled rejection 终止进程。
        await autoUpdater.downloadUpdate();
      } catch (err) {
        console.error('[updater] download failed:', err.message);
      }
    });
    autoUpdater.on('update-downloaded', async (info) => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        message: `新版本 ${info.version} 已下载,重启后生效`,
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
    autoUpdater.on('update-not-available', () => {
      if (manualMode) dialog.showMessageBox({ type: 'info', message: '已是最新版本' });
    });
    autoUpdater.on('error', (err) => {
      // 静默模式也留日志——错误事件可能不伴随 promise rejection(如下载中途失败),
      // 只在弹窗分支打日志会丢掉启动后静默检查的失败现场。
      console.error('[updater] update error:', err.message);
      if (manualMode) dialog.showMessageBox({ type: 'error', message: `检查更新失败: ${err.message}` });
    });
  }
  manualMode = manual;
  if (!checkedOnce && !manual) {
    checkedOnce = true;
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed:', err.message));
  }
  if (manual) {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed:', err.message));
  }
}

module.exports = { initUpdater };
