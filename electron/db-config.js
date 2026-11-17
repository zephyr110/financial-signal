'use strict';
const fs = require('fs');
const path = require('path');

/** 与 lib/db-config.ts 同格式：{ backend, tursoUrl?, tursoToken? }。 */
function dbConfigFile(dbPath) {
  return path.join(path.dirname(dbPath), 'db-config.json');
}

/** dev 与服务端读同一个 DB_CONFIG_PATH；打包版固定用数据目录（见 README）。 */
function dbConfigPathFor({ dev, env = process.env, dbPath }) {
  if (dev && env.DB_CONFIG_PATH) return env.DB_CONFIG_PATH;
  return dbConfigFile(dbPath);
}

function readDbConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.backend !== 'local' && raw.backend !== 'turso') return null;
    const tursoUrl = typeof raw.tursoUrl === 'string' ? raw.tursoUrl.trim() : '';
    if (raw.backend === 'turso' && !tursoUrl) return null;
    const tursoToken = typeof raw.tursoToken === 'string' ? raw.tursoToken.trim() : '';
    return {
      backend: raw.backend,
      ...(tursoUrl ? { tursoUrl } : {}),
      ...(tursoToken ? { tursoToken } : {}),
    };
  } catch {
    return null;
  }
}

/** 与 lib/db-config.ts 的 isRemoteDbConfigured 同优先级：环境变量 > Vercel > 设置文件。 */
function isRemoteDbConfig(env = process.env, stored = null) {
  const backend = String(env.DB_BACKEND || '').trim().toLowerCase();
  if (backend === 'turso') return true;
  if (backend === 'local') return false;
  if (env.VERCEL) return true;
  return stored?.backend === 'turso';
}

module.exports = { dbConfigFile, dbConfigPathFor, readDbConfig, isRemoteDbConfig };
