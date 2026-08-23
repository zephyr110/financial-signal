'use strict';
const net = require('net');
const http = require('http');

/** 找一个可监听的随机端口(127.0.0.1)。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询探测 URL 是否可访问(返回 2xx/3xx 即视为健康)。 */
function waitForHealthy(url, { timeoutMs = 30000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      let retried = false;
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 400) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
      function retry() {
        if (retried) return;
        retried = true;
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryOnce, intervalMs);
      }
    };
    tryOnce();
  });
}

/** 生成 standalone server 的 spawn 环境变量。 */
function buildServerEnv({ port, dbPath, extra = {} }) {
  return {
    ...process.env,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    DESKTOP_MODE: '1',
    NODE_ENV: 'production',
    ...(dbPath ? { NEWS_DB_PATH: dbPath } : {}),
    ...extra,
  };
}

module.exports = { findFreePort, waitForHealthy, buildServerEnv };
