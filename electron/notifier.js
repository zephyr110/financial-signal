'use strict';
const { Notification } = require('electron');
const { createClient } = require('./libsql-client');
const { queryNewHighSignals } = require('./notify-query');
const { loadConfig, saveConfig } = require('./store');

// 每轮最多推送条数。游标按"已处理区间"推进(见 notify-query.js 注释):
// 高水位 = 本轮最新已处理行,低边界 = 满批(截断)时最旧已处理行——
// 截断尾部下轮继续取,不静默丢通知;批内行不被重复通知。
const NOTIFY_LIMIT = 5;

/** 解析 config.json 中可能为旧格式(纯字符串)的通知游标。 */
function parseCursor(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && typeof raw.at === 'string') {
    return {
      at: raw.at,
      id: Number(raw.id) || 0,
      low: raw.low ? { at: String(raw.low.at), id: Number(raw.low.id) || 0 } : null,
    };
  }
  // 旧纯字符串格式:只表达"已通知到该时刻" → 该时刻所有行都算已处理
  // (id 视作无穷大,与旧版"严格大于 since"语义一致;id=0 会把同秒行重复通知)
  return { at: String(raw), id: Number.MAX_SAFE_INTEGER, low: null };
}

/** 字典序比较 (at, rowid):row 是否严格新于游标。 */
function isNewerThan(row, c) {
  return row.analyzedAt > c.at || (row.analyzedAt === c.at && row.rowid > c.id);
}

/** 字典序比较 (at, rowid):row 是否严格旧于游标。 */
function isOlderThan(row, c) {
  return row.analyzedAt < c.at || (row.analyzedAt === c.at && row.rowid < c.id);
}

/** 分析完成后查询新增高分信号并推送;返回本次查询到的条数。 */
async function notifyNewHighSignals({
  dbPath,
  configFile,
  onActivate,
  NotificationImpl = Notification, // 测试注入用,默认 Electron 主进程 Notification
}) {
  const cfg = loadConfig(configFile, { notifyLastRunAt: null });
  const prev = parseCursor(cfg.notifyLastRunAt);
  const client = createClient({ url: `file:${dbPath}` });
  let rows;
  try {
    rows = await queryNewHighSignals(client, prev, NOTIFY_LIMIT);
  } finally {
    await client.close();
  }
  const unsupported = !NotificationImpl.isSupported();
  for (const row of rows) {
    // 单条失败不能中断循环:记日志后继续(与 unsupported 一致,整批仍算已处理)
    try {
      if (!unsupported) {
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
  // 推进游标:高水位单调不减(全尾批时不得回退,否则已处理行被重复查询);
  // 满批时低边界 = 最旧已处理行,承接截断尾部;不满批说明区间已全覆盖 → 清低边界。
  const full = rows.length >= NOTIFY_LIMIT;
  let next = cfg.notifyLastRunAt;
  if (rows.length > 0) {
    const newest = rows[0]; // DESC 序第一行 = 最新
    const oldest = rows[rows.length - 1]; // DESC 序最后一行 = 最旧
    const high =
      prev && !isNewerThan(newest, prev)
        ? { at: prev.at, id: prev.id }
        : { at: newest.analyzedAt, id: newest.rowid };
    const low = full
      ? prev && prev.low && !isOlderThan(oldest, prev.low)
        ? prev.low
        : { at: oldest.analyzedAt, id: oldest.rowid }
      : null;
    next = { ...high, low };
  }
  saveConfig(configFile, { ...cfg, notifyLastRunAt: next });
  return rows.length;
}

module.exports = { notifyNewHighSignals };
