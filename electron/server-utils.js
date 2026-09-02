'use strict';
const net = require('net');
const http = require('http');
const path = require('path');

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

// 透传给 child 的白名单。绝不能 spread 整个 process.env:
// 宿主的 TURSO_DATABASE_URL/TURSO_AUTH_TOKEN 会被 lib/db.ts 的 Turso 分支优先采用,
// 桌面端本地库被静默重定向到用户远程 Turso 账号(本地文件永不创建/永不更新)。
const ENV_WHITELIST = [
  'LLM_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
  'LLM_TEMPERATURE', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS',
  'LLM_INPUT_PRICE', 'LLM_OUTPUT_PRICE', 'LLM_PRICE_CURRENCY',
];

/** 生成 standalone server 的 spawn 环境变量。 */
function buildServerEnv({ port, dbPath, extra = {} }) {
  const env = {};
  for (const key of ENV_WHITELIST) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return {
    ...env,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    DESKTOP_MODE: '1',
    NODE_ENV: 'production',
    ...(dbPath
      ? {
          NEWS_DB_PATH: dbPath,
          AUTH_DB_PATH: path.join(path.dirname(dbPath), 'auth.db'),
        }
      : {}),
    ...extra,
  };
}

module.exports = { findFreePort, waitForHealthy, buildServerEnv };
