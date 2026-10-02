import path from 'path';
import os from 'os';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

/**
 * 查询层配额防护测试(Turso 免费额度:reads 500M/月、writes 10M/月):
 * - getNewsByDate 范围查询与原 DATE(published_at)=? 的边界等价性(索引可用性由 SQL 形态保证)
 * - getRelatedSignals 默认 90 天窗口(消除无界全表 json_each 求值)
 * - pruneEventLog / getEventMetrics 与 created_at(datetime('now') 空格格式)同格式比较
 * - saveMarketData 分批写入
 * 隔离:独立 DB 文件 + vi.resetModules(模块级 client 单例);测试环境读缓存默认 bypass。
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-queries-test-'));

async function loadDb(file: string) {
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.NEWS_DB_PATH = file;
  vi.resetModules();
  return import('../lib/db');
}

describe('查询层(配额防护)', () => {
  let mod: Awaited<ReturnType<typeof loadDb>>;
  let db: any;

  beforeEach(async () => {
    const file = path.join(dir, `q-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    mod = await loadDb(file);
    db = await mod.getDb();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function insertNews(published_at: string, source_id: string) {
    const r = await db.execute({
      sql: 'INSERT INTO news_archive (source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?)',
      args: ['test', source_id, 't', 'c', published_at],
    });
    return Number(r.lastInsertRowid);
  }

  describe('getNewsByDate 范围查询(替代 DATE() 全表扫描)', () => {
    it('UTC 日界精确:当日 00:00:00 起、次日 00:00:00 止(毫秒边界不串日)', async () => {
      await insertNews('2026-10-01T23:59:59.999Z', 'a');
      await insertNews('2026-10-02T00:00:00.000Z', 'b');
      await insertNews('2026-10-02T12:30:00.000Z', 'c');
      await insertNews('2026-10-02T23:59:59.999Z', 'd');
      await insertNews('2026-10-03T00:00:00.000Z', 'e');

      const rows = await mod.getNewsByDate('2026-10-02');
      expect(rows.map((r: any) => r.source_id)).toEqual(['d', 'c', 'b']); // published_at DESC
      expect((await mod.getNewsByDate('2026-10-01')).map((r: any) => r.source_id)).toEqual(['a']);
      expect((await mod.getNewsByDate('2026-10-03')).map((r: any) => r.source_id)).toEqual(['e']);
      expect(await mod.getNewsByDate('2026-09-30')).toEqual([]);
    });

    it('非法/非规范化日期返回空(与原 DATE() 比较语义一致)', async () => {
      await insertNews('2026-10-02T10:00:00.000Z', 'x');
      expect(await mod.getNewsByDate('2026-10-2')).toEqual([]);
      expect(await mod.getNewsByDate('2026-02-30')).toEqual([]); // Date 会滚动到 3 月,由往返校验拦截
      expect(await mod.getNewsByDate('garbage')).toEqual([]);
      expect(await mod.getNewsByDate('')).toEqual([]);
    });
  });

  describe('getRelatedSignals 时间窗', () => {
    async function insertSignal(published_at: string, source_id: string) {
      const newsId = await insertNews(published_at, source_id);
      await db.execute({
        sql: `INSERT INTO analysis_result (news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
              VALUES (?, 4, 'industry', 'significant', ?, ?, 'positive', 's')`,
        args: [newsId, JSON.stringify(['半导体']), JSON.stringify([])],
      });
    }

    it('默认只取 90 天内相关信号;放宽窗口后历史信号回归', async () => {
      await insertSignal(new Date(Date.now() - 24 * 3600 * 1000).toISOString(), 'recent');
      await insertSignal(new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(), 'old');

      const rows = await mod.getRelatedSignals(999, ['半导体'], [], 5);
      expect(rows).toHaveLength(1);

      const wide = await mod.getRelatedSignals(999, ['半导体'], [], 5, 365);
      expect(wide).toHaveLength(2);
    });
  });

  describe('event_log 时间比较与保留清理', () => {
    it('pruneEventLog 按同格式边界删除:超期删、窗口内留', async () => {
      await db.execute({
        sql: "INSERT INTO event_log (event_type, created_at) VALUES ('old', datetime('now', '-100 days'))",
        args: [],
      });
      await db.execute({
        sql: "INSERT INTO event_log (event_type, created_at) VALUES ('recent', datetime('now', '-10 days'))",
        args: [],
      });
      await mod.pruneEventLog(90);
      const rows = await db.execute({ sql: 'SELECT event_type FROM event_log', args: [] });
      expect(rows.rows.map((r: any) => r.event_type)).toEqual(['recent']);
    });

    it('getEventMetrics 统计当天写入的埋点(空格格式边界不排除边界日)', async () => {
      await db.execute({
        sql: `INSERT INTO event_log (event_type, payload) VALUES ('page_view', '{"session":"s1"}')`,
        args: [],
      });
      await db.execute({
        sql: `INSERT INTO event_log (event_type, payload) VALUES ('page_view', '{"session":"s2"}')`,
        args: [],
      });
      const m = await mod.getEventMetrics(7);
      expect(m.uniqueSessions).toBe(2);
      const pv = m.events.find((e: any) => e.event_type === 'page_view');
      expect(pv.count).toBe(2);
    });
  });

  describe('saveMarketData 批量写', () => {
    it('>50 行分两批全部写入', async () => {
      const market = await import('../lib/market'); // 与 loadDb 共享同一模块缓存(同一 db 实例)
      const rows = Array.from({ length: 60 }, (_, i) => ({
        code: `BK${i}`, name: `板块${i}`, type: 'industry', close: 100 + i, change_pct: 0.5, volume: 1000,
      }));
      const inserted = await market.saveMarketData(rows);
      expect(inserted).toBe(60);
      const cnt = await db.execute({ sql: 'SELECT COUNT(*) as n FROM market_data', args: [] });
      expect(Number(cnt.rows[0].n)).toBe(60);
    });
  });
});
