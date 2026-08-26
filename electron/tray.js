'use strict';
const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { resolveStandaloneDir } = require('./libsql-client');

let tray = null;

/** public 内资源:优先 standalone(打包后),回退仓库 public(dev)。 */
function resolvePublic(name) {
  const standaloneAsset = path.join(resolveStandaloneDir(), 'public', name);
  return fs.existsSync(standaloneAsset)
    ? standaloneAsset
    : path.join(__dirname, '..', 'public', name);
}

function createTray({ onOpen, onFetchNow, onOpenDataDir, onCheckUpdate, onQuit }) {
  // 菜单栏图标必须是 template 图(16pt/@2x,纯黑 + alpha):macOS 自动适配深浅色
  // 与菜单栏尺寸;直接塞 logo.png(676×781 彩色大图)会以异常尺寸渲染。
  // createFromPath 自动配对同名 @2x;文件名带 Template 后缀 + 显式 setTemplateImage
  // 双保险(macOS 菜单栏按 template 处理,黑/深色菜单栏自动反色)。
  const icon = nativeImage.createFromPath(resolvePublic('trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Financial Signal');
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: onOpen },
    { label: '立即抓取', click: onFetchNow },
    { label: '打开数据目录', click: onOpenDataDir },
    ...(onCheckUpdate ? [{ label: '检查更新…', click: onCheckUpdate }] : []),
    { type: 'separator' },
    { label: '退出', click: onQuit },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', onOpen);
  return tray;
}

module.exports = { createTray };
