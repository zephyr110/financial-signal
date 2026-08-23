'use strict';
const { createClient } = require('@libsql/client');

/** 读 app_settings 表全量键值(不依赖 Web 侧 lib/settings.ts 缓存)。 */
async function getSettings(dbPath) {
  if (!dbPath) return {};
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const r = await client.execute({ sql: 'SELECT key, value FROM app_settings', args: [] });
    const out = {};
    for (const row of r.rows) out[String(row.key)] = String(row.value);
    return out;
  } catch {
    return {};
  } finally {
    await client.close();
  }
}

module.exports = { getSettings };
