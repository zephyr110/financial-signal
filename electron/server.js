'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { findFreePort, waitForHealthy, buildServerEnv } = require('./server-utils');

const MAX_RESTARTS = 5;
const STANDALONE_DIR = path.join(__dirname, '..', '.next', 'standalone');

let child = null;
let restarts = 0;
let currentUrl = null;
let stopping = false;
let restartTimer = null;

/** dev 模式返回固定 URL(next dev 由 dev:desktop 脚本管理)。 */
function devUrl() {
  return 'http://127.0.0.1:3010';
}

/** prod 模式:选端口 → spawn standalone → 等健康 → 返回 baseUrl。 */
async function startServer({ dbPath, onCrash }) {
  const port = await findFreePort();
  const serverJs = path.join(STANDALONE_DIR, 'server.js');
  const env = buildServerEnv({ port, dbPath });

  child = spawn('node', [serverJs], {
    cwd: STANDALONE_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  child.stdout.on('data', (d) => {
    const line = String(d).trim();
    if (line && !line.startsWith('✓')) process.stdout.write(`[server] ${line}\n`);
  });
  child.on('error', (err) => {
    console.error('[server] spawn error:', err.message);
  });

  child.on('exit', (code) => {
    child = null;
    if (stopping) return; // 主动关闭(退出应用),不再重启
    if (restarts < MAX_RESTARTS) {
      restarts += 1;
      const delay = Math.min(1000 * 2 ** restarts, 30000);
      console.log(`[server] exited(${code}), restart in ${delay}ms (${restarts}/${MAX_RESTARTS})`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (stopping) return; // 已 stopServer,不再重启
        startServer({ dbPath, onCrash }).then(onCrash).catch(() => {});
      }, delay);
    } else {
      console.error('[server] too many crashes, giving up');
    }
  });

  // 启动期:首个 child 在变健康前退出 → 立即失败,由重启循环接管
  // (exit 监听不重复触发重启逻辑,只是额外 resolve 一个 promise)
  const c = child;
  const exitBeforeHealthy = new Promise((resolve) => {
    const onFirstExit = () => {
      c.removeListener('exit', onFirstExit);
      resolve();
    };
    c.on('exit', onFirstExit);
  });

  const url = `http://127.0.0.1:${port}`;
  currentUrl = url;
  const healthy = await Promise.race([
    waitForHealthy(`${url}/api/health`),
    exitBeforeHealthy.then(() => false),
  ]);
  if (!healthy) throw new Error('standalone server exited before becoming healthy');
  return url;
}

/** 当前 server 的 baseUrl(未启动返回 null)。 */
function serverBaseUrl() {
  return currentUrl;
}

/** 主动停掉 standalone 子进程(应用退出时调用,不再触发重启)。 */
function stopServer() {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const c = child;
  child = null;
  currentUrl = null;
  if (!c) return;
  c.kill('SIGTERM');
  // exitCode 为 null 表示进程尚未退出 → 兜底 SIGKILL
  // (不能用 c.killed:kill() 一调用它就置 true,不是"已退出"的意思)
  setTimeout(() => {
    if (c.exitCode === null) c.kill('SIGKILL');
  }, 500).unref();
}

module.exports = { startServer, devUrl, serverBaseUrl, stopServer };
