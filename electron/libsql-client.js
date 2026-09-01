'use strict';
const path = require('path');
const { createRequire } = require('module');

/**
 * 主进程的 @libsql/client 解析。
 *
 * 打包时根 node_modules 被排除(files: "!node_modules/**"),而 standalone 产物
 * (extraResources → Resources/standalone)自带 Next 追踪好的 @libsql/client 及其
 * 原生平台包(@libsql/darwin-x64 等,真实文件在磁盘上,asar 外)。优先从那里解析;
 * dev / 测试 / standalone 未构建时回退根 node_modules。
 */
function resolveStandaloneDir() {
  // 用 process.versions.electron 检测运行环境,而非 require('electron'):
  // 在 vitest/普通 node 下 require('electron') 会因缺二进制挂起/抛错,
  // 顶层调用链(server.js 等)在测试里会被整体拖死;该字段仅 Electron 主进程存在。
  const isElectron = Boolean(process.versions.electron);
  const isPackaged = isElectron && process.resourcesPath && require('electron').app.isPackaged;
  return isPackaged
    ? path.join(process.resourcesPath, 'standalone')
    : path.join(__dirname, '..', '.next', 'standalone');
}

function resolveClientModule() {
  const bases = [path.join(resolveStandaloneDir(), 'server.js')];
  for (const base of bases) {
    try {
      return createRequire(base)('@libsql/client');
    } catch {
      // standalone 缺失/未构建,尝试下一候选
    }
  }
  return require('@libsql/client');
}

module.exports = { createClient: resolveClientModule().createClient, resolveStandaloneDir };
