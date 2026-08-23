'use strict';
const { autoUpdater } = require('electron-updater');
const { dialog } = require('electron');

let checkedOnce = false;
// 检查/下载进行中时忽略新检查:启动静默检查与托盘手动检查重叠会
// 双重弹窗、两个 update-available 都去 downloadUpdate(第二次必失败)。
let busy = false;
// 静默路径已进入下载:checkForUpdates 的 promise 在事件之后才 resolve,
// 若此时复位 busy,下载在途的窗口会重新打开 → 下载期间保持 busy。
let downloading = false;
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
          if (response !== 0) {
            busy = false;
            return;
          }
        } else {
          downloading = true; // 事件先于 checkForUpdates resolve,标记下载在途
        }
        // downloadUpdate 失败会同时 dispatch 'error' 并 reject;不捕获的话
        // async 监听器的 rejection 无人理会 → unhandled rejection 终止进程。
        await autoUpdater.downloadUpdate();
      } catch (err) {
        console.error('[updater] download failed:', err.message);
      } finally {
        busy = false;
        downloading = false;
      }
    });
    autoUpdater.on('update-downloaded', async (info) => {
      try {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          buttons: ['立即重启', '稍后'],
          defaultId: 0,
          message: `新版本 ${info.version} 已下载,重启后生效`,
        });
        if (response === 0) autoUpdater.quitAndInstall();
      } catch (err) {
        // 应用退出/窗口销毁时 dialog 会 reject → 未处理 rejection 会终止进程
        console.error('[updater] update prompt failed:', err.message);
      }
    });
    autoUpdater.on('update-not-available', () => {
      busy = false;
      if (manualMode) dialog.showMessageBox({ type: 'info', message: '已是最新版本' });
    });
    autoUpdater.on('error', (err) => {
      busy = false;
      // 静默模式也留日志——错误事件可能不伴随 promise rejection(如下载中途失败),
      // 只在弹窗分支打日志会丢掉启动后静默检查的失败现场。
      console.error('[updater] update error:', err.message);
      if (manualMode) dialog.showMessageBox({ type: 'error', message: `检查更新失败: ${err.message}` });
    });
  }
  manualMode = manual;
  // 首次静默检查或任意手动检查(两者互斥,合并为同一分支)
  if (manual || !checkedOnce) {
    if (busy || downloading) {
      console.log('[updater] check/download in progress, skipping');
      return;
    }
    checkedOnce = true;
    busy = true;
    autoUpdater
      .checkForUpdates()
      .then(() => {
        if (!downloading) busy = false; // 静默下载在途时保持 busy(见 downloading 注释)
      })
      .catch((err) => {
        console.error('[updater] check failed:', err.message);
        busy = false;
      });
  }
}

module.exports = { initUpdater };
