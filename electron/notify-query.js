'use strict';

/**
 * 查询 cursor 之后新完成分析的信号分 >= 4 的新闻(供桌面通知)。
 * db: @libsql client(调用方注入,测试用临时库)。
 *
 * 游标描述"已处理区间":high 是最新一条已处理行(高水位,单调不减),
 * low 是最旧一条已处理行(仅当最近一轮满批、被 LIMIT 截断时存在)。
 * 未处理行 = 比 high 新(新到)∪ 比 low 旧(截断尾部),查询同时覆盖两侧。
 * 单边界做不到不重不漏:高水位推到最新 → 截断行永久丢失(旧实现);
 * 推到最旧 → 批内中间行被重复通知。
 *
 * 同一秒多行由 rowid 决胜:SQLite datetime('now') 是秒精度,同秒写入多行
 * 时仅按时间严格比较会永久漏行;id 由 libsql 保证递增。at 接受 ISO-8601
 * 或 SQLite 存储格式(datetime(?) 归一化后可正确字典序比较)。
 *
 * 注意:不能用 a.rowid 当结果列——libsql 驱动会把 rowid 结果列改名成表
 * 的主键列名(id),与 n.id 撞名后 rowid 键消失(实测 undefined)。
 * 两表都是 INTEGER PRIMARY KEY AUTOINCREMENT(rowid 即 id),用 a.id 等价。
 *
 * cursor: { at, id, low: {at, id} | null } | string(旧格式,无 low 边界;
 * id 视作无穷大:该时刻所有行都已处理,与旧版 "严格大于 since" 语义一致)| null(全部从头)。
 */
function normalizeCursor(raw) {
  if (!raw) return { at: '2000-01-01T00:00:00Z', id: 0, low: null };
  if (typeof raw === 'object' && typeof raw.at === 'string') {
    return {
      at: raw.at,
      id: Number(raw.id) || 0,
      low: raw.low ? { at: String(raw.low.at), id: Number(raw.low.id) || 0 } : null,
    };
  }
  // 旧纯字符串格式:只表达"已通知到该时刻" → 该时刻所有行都算已处理
  return { at: String(raw), id: Number.MAX_SAFE_INTEGER, low: null };
}

async function queryNewHighSignals(db, cursor, limit = 20) {
  const c = normalizeCursor(cursor);
  const args = [c.at, c.at, c.id];
  let tailClause = '';
  if (c.low) {
    tailClause =
      ' OR (a.analyzed_at < datetime(?) OR (a.analyzed_at = datetime(?) AND a.id < ?))';
    args.push(c.low.at, c.low.at, c.low.id);
  }
  const r = await db.execute({
    sql: `SELECT n.id, n.title, a.signal_score, a.analyzed_at, a.id AS rowid
          FROM analysis_result a
          JOIN news_archive n ON n.id = a.news_id
          WHERE a.signal_score >= 4
            AND ((a.analyzed_at > datetime(?) OR (a.analyzed_at = datetime(?) AND a.id > ?))${tailClause})
          ORDER BY a.analyzed_at DESC, a.id DESC
          LIMIT ?`,
    args: [...args, limit],
  });
  return r.rows.map((row) => ({
    newsId: Number(row.id),
    title: String(row.title || ''),
    signalScore: Number(row.signal_score),
    analyzedAt: String(row.analyzed_at),
    rowid: Number(row.rowid),
  }));
}

module.exports = { queryNewHighSignals };
