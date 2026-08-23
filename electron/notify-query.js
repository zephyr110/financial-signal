'use strict';

/**
 * 查询 since 之后新完成分析的信号分 >= 4 的新闻(供桌面通知)。
 * db: @libsql client(调用方注入,测试用临时库)。
 * sinceIso 接受 ISO-8601;SQL 侧用 datetime(?) 把入参归一化为
 * SQLite 存储格式(YYYY-MM-DD HH:MM:SS),与 datetime('now') 写入的
 * analyzed_at 可正确字典序比较。
 */
async function queryNewHighSignals(db, sinceIso, limit = 20) {
  const r = await db.execute({
    sql: `SELECT n.id, n.title, a.signal_score, a.analyzed_at
          FROM analysis_result a
          JOIN news_archive n ON n.id = a.news_id
          WHERE a.signal_score >= 4 AND a.analyzed_at > datetime(?)
          ORDER BY a.analyzed_at DESC
          LIMIT ?`,
    args: [sinceIso, limit],
  });
  return r.rows.map((row) => ({
    newsId: Number(row.id),
    title: String(row.title || ''),
    signalScore: Number(row.signal_score),
    analyzedAt: String(row.analyzed_at),
  }));
}

module.exports = { queryNewHighSignals };
