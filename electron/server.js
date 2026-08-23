'use strict';
const path = require('path');
const { findFreePort, waitForHealthy, buildServerEnv } = require('./server-utils');
const { resolveStandaloneDir } = require('./libsql-client');

const MAX_RESTARTS = 5;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
// 打包后 standalone 经 extraResources 落在 Resources/standalone(asar 外,plain node
// 子进程必须从真实磁盘读取);dev 布局为 .next/standalone。
const STANDALONE_DIR = resolveStandaloneDir();

/** dev 模式返回固定 URL(next dev 由 dev:desktop 脚本管理)。 */
function devUrl() {
  return 'http://127.0.0.1:3010';
}

/**
 * 管理 standalone server 生命周期(spawn/健康检查/崩溃退避重启 ≤5 次/stop)。
 * 依赖全部可注入(spawn/waitForHealthy/findFreePort/定时器/日志),便于单测。
 * 'exit' 与 spawn 'error' 走同一条重启路径;健康后 restarts 归零(连续失败语义);
 * 重启次数耗尽时回调 onGiveUp(由调用方决定是否退出应用)。
 */
function createServerManager({
  spawn,
  dbPath,
  baseUrl = 'http://127.0.0.1',
  onCrash,
  onGiveUp,
  log = console.log,
  errorLog = console.error,
  findFreePort: findFreePortImpl = findFreePort,
  waitForHealthy: waitForHealthyImpl = waitForHealthy,
  setTimeout: setTimeoutImpl = setTimeout,
  clearTimeout: clearTimeoutImpl = clearTimeout,
} = {}) {
  let child = null;
  let restarts = 0;
  let stopping = false;
  let restartTimer = null;
  let currentUrl = null;
  let lastSpawnError = null;

  /** 崩溃/spawn 失败后的统一退避重启;次数耗尽时通知 onGiveUp。 */
  function scheduleRestart(code, signal) {
    if (stopping) return;
    if (restarts < MAX_RESTARTS) {
      restarts += 1;
      const delay = Math.min(BASE_RETRY_MS * 2 ** restarts, MAX_RETRY_MS);
      log(`[server] exited(${code}${signal ? ' sig=' + signal : ''}), restart in ${delay}ms (${restarts}/${MAX_RESTARTS})`);
      restartTimer = setTimeoutImpl(() => {
        restartTimer = null;
        if (stopping) return;
        start().then(onCrash).catch((err) => {
          // start() 抛错但 child 已 spawn(30s 健康检查超时、进程活着):
          // 旧代码 catch(() => {}) 把错误吞掉 → 活着的 child 脱管、无人再重启,
          // 应用永远挂在旧 URL 上。这里 SIGKILL 让 'exit' 事件驱动正常重启计数
          // (child 仍指向该实例,代际守卫不拦截),次数耗尽后自然走到 onGiveUp。
          // spawn 失败的场景 child 已为 null,'error' 事件已调度过重启,无需处理。
          errorLog('[server] start failed, killing unhealthy child:', err.message);
          const c = child;
          if (c && c.exitCode === null) c.kill('SIGKILL');
        });
      }, delay);
    } else {
      errorLog('[server] too many crashes, giving up');
      if (onGiveUp) onGiveUp();
    }
  }

  /** 选端口 → spawn standalone → 等健康 → 返回 baseUrl。 */
  async function start() {
    stopping = false; // stop 后仍可再次 start(幂等)
    // 旧代际遗留的重启定时器在新生命周期开始时作废:restartAfterDbChange 场景下
    // 旧 child 的 exit 已调度 restart 但 timer 尚未触发,stop() 清不到它,必须在新 start 清。
    if (restartTimer) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
    lastSpawnError = null;
    const port = await findFreePortImpl();
    const serverJs = path.join(STANDALONE_DIR, 'server.js');
    const env = buildServerEnv({ port, dbPath });

    let exitBeforeHealthyResolve;
    const exitBeforeHealthy = new Promise((resolve) => { exitBeforeHealthyResolve = resolve; });

    // 不依赖系统 node:用当前进程的可执行文件(dev 为 Electron.app 二进制,打包后为
    // "Financial Signal.app/Contents/MacOS/Financial Signal")以 ELECTRON_RUN_AS_NODE
    // 模式当 node 跑 standalone server → dev/prod 统一,分发机器无需安装 node。
    const spawned = spawn(process.execPath, [serverJs], {
      cwd: STANDALONE_DIR,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = spawned;
    spawned.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    spawned.stdout.on('data', (d) => {
      const line = String(d).trim();
      if (line && !line.startsWith('✓')) process.stdout.write(`[server] ${line}\n`);
    });
    // spawn 失败(ENOENT 等)不发 'exit',只发 'error' + 'close' → 与 'exit' 统一走重启路径
    // 代际守卫:stop→start 连续序列下,被 SIGTERM 的旧 child 的 'exit' 在下一事件循环
    // 才送达,此时 child 已指向新实例(或仍为 null)→ 必须忽略旧实例的 exit/error,
    // 否则误判崩溃 → 清掉新进程引用 + 2s 后拉出第三个 server(幽灵重启,新 server 脱管成孤儿)。
    spawned.on('error', (err) => {
      if (child !== spawned) return;
      lastSpawnError = err.message;
      child = null;
      exitBeforeHealthyResolve();
      errorLog('[server] spawn error:', err.message);
      scheduleRestart(null, 'spawn-error');
    });
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return;
      child = null;
      exitBeforeHealthyResolve();
      scheduleRestart(code, signal);
    });

    const url = `${baseUrl}:${port}`;
    currentUrl = url;
    const healthy = await Promise.race([
      waitForHealthyImpl(`${url}/api/health`),
      exitBeforeHealthy.then(() => false),
    ]);
    if (!healthy) {
      throw new Error(lastSpawnError
        ? `standalone server spawn failed: ${lastSpawnError}`
        : 'standalone server exited before becoming healthy');
    }
    restarts = 0; // 连续失败语义:健康后重置(退避 delay 只在连续失败时增长)
    return url;
  }

  /** 当前 server 的 baseUrl(未启动返回 null)。 */
  function getUrl() {
    return currentUrl;
  }

  /** 主动停掉 standalone 子进程(应用退出时调用,不再触发重启)。 */
  function stop() {
    stopping = true;
    if (restartTimer) {
      clearTimeoutImpl(restartTimer);
      restartTimer = null;
    }
    const c = child;
    child = null;
    currentUrl = null;
    if (!c) return;
    c.kill('SIGTERM');
    // exitCode 为 null 表示进程尚未退出 → 兜底 SIGKILL
    // (不能用 c.killed:kill() 一调用它就置 true,不是"已退出"的意思)
    const t = setTimeoutImpl(() => {
      if (c.exitCode === null) c.kill('SIGKILL');
    }, 500);
    if (t && typeof t.unref === 'function') t.unref();
  }

  return { start, stop, getUrl };
}

module.exports = { createServerManager, devUrl };
