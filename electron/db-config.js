'use strict';
const fs = require('fs');
const path = require('path');

/** 与 lib/db-config.ts 同格式：{ backend, tursoUrl?, tursoToken? }。 */
function dbConfigFile(dbPath) {
  return path.join(path.dirname(dbPath), 'db-config.json');
}

function readDbConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.backend !== 'local' && raw.backend !== 'turso') return null;
    const tursoUrl = typeof raw.tursoUrl === 'string' ? raw.tursoUrl.trim() : '';
    if (raw.backend === 'turso' && !tursoUrl) return null;
    const tursoToken = typeof raw.tursoToken === 'string' ? raw.tursoToken.trim() : '';
    return { backend: raw.backend, tursoUrl, tursoToken };
  } catch {
    return null;
  }
}

module.exports = { dbConfigFile, readDbConfig };
