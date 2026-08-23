'use strict';
const { Tray, Menu, app } = require('electron');
const path = require('path');
const { resolveStandaloneDir } = require('./libsql-client');

let tray = null;

function createTray({ onOpen, onFetchNow, onOpenDataDir, onCheckUpdate, onQuit }) {
  // __dirname 在 asar 内,public 经 copy-standalone 落在 standalone/public(打包后
  // 在 Resources/standalone/public,asar 外真实磁盘)——必须用 resolveStandaloneDir。
  tray = new Tray(path.join(resolveStandaloneDir(), 'public', 'logo.png'));
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
