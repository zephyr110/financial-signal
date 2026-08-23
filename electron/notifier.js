'use strict';
const { Notification } = require('electron');
const { createClient } = require('./libsql-client');
const { queryNewHighSignals } = require('./notify-query');
const { loadConfig, saveConfig } = require('./store');

/** 分析完成后查询新增高分信号并推送;返回推送条数。 */
async function notifyNewHighSignals({
  dbPath,
  configFile,
  onActivate,
  NotificationImpl = Notification, // 测试注入用,默认 Electron 主进程 Notification
}) {
  const cfg = loadConfig(configFile, { notifyLastRunAt: null });
  const since = cfg.notifyLastRunAt || '2000-01-01T00:00:00Z';
  const client = createClient({ url: `file:${dbPath}` });
  let rows;
  try {
    rows = await queryNewHighSignals(client, since);
  } finally {
    await client.close();
  }
  if (rows.length > 0) {
    for (const row of rows.slice(0, 5)) {
      // 单条失败不能中断循环:记日志后继续,游标照常推进(与 unsupported 语义一致)
      try {
        if (NotificationImpl.isSupported()) {
          const n = new NotificationImpl({
            title: `信号 ${row.signalScore} 分: ${row.title.slice(0, 40)}`,
            body: row.title,
          });
          n.on('click', () => { if (onActivate) onActivate(); });
          n.show();
        }
      } catch (err) {
        console.error('[notifier] failed to show notification:', err.message);
      }
    }
  }
  const newest = rows[0] ? rows[0].analyzedAt : cfg.notifyLastRunAt;
  saveConfig(configFile, { ...cfg, notifyLastRunAt: newest || cfg.notifyLastRunAt });
  return rows.length;
}

module.exports = { notifyNewHighSignals };
