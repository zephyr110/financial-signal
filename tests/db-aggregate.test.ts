import path from 'path';
import os from 'os';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-aggregate-test-'));

async function loadDb(file: string) {
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.NEWS_DB_PATH = file;
  vi.resetModules();
  return import('../lib/db');
}

describe('SQL 聚合读路径', () => {
  let mod: Awaited<ReturnType<typeof loadDb>>;

  beforeEach(async () => {
    const file = path.join(dir, `agg-${Date.now()}.db`);
    mod = await loadDb(file);
    const db = await mod.getDb();
    const now = new Date().toISOString();
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [1, 'test', 'n1', 't1', 'c1', now],
    });
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [2, 'test', 'n2', 't2', 'c2', now],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
            VALUES (1, 1, 4, 'industry', 'significant', ?, ?, 'positive', 's1')`,
      args: [JSON.stringify(['半导体', '存储']), JSON.stringify(['中芯国际'])],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
            VALUES (2, 2, 5, 'industry', 'critical', ?, ?, 'negative', 's2')`,
      args: [JSON.stringify(['半导体']), JSON.stringify(['中芯国际', '长电科技'])],
    });
  });

  it('getIndustryHeatmap 按行业 SQL 聚合', async () => {
    const rows = await mod.getIndustryHeatmap(24);
    const semi = rows.find((r) => r.industry === '半导体');
    const storage = rows.find((r) => r.industry === '存储');
    expect(semi?.signalCount).toBe(2);
    expect(storage?.signalCount).toBe(1);
    expect(semi?.avgScore).toBe(4.5);
  });

  it('getIndustryHeatmap 关注行业过滤', async () => {
    const rows = await mod.getIndustryHeatmap(24, ['存储']);
    expect(rows).toHaveLength(1);
    expect(rows[0].industry).toBe('存储');
  });

  it('getCompanyHeatmap 按公司 SQL 聚合并 LIMIT 10', async () => {
    const rows = await mod.getCompanyHeatmap(24);
    const smic = rows.find((r) => r.company === '中芯国际');
    expect(smic?.signalCount).toBe(2);
    expect(smic?.avgScore).toBe(4.5);
  });

  it('getIndustryTrend 返回分桶趋势', async () => {
    const rows = await mod.getIndustryTrend(24);
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1] as Record<string, unknown>;
    expect(last.time).toBeTruthy();
    expect(Number(last['半导体'])).toBeGreaterThan(0);
  });

  it('getSignalById 经 event_thread_signal 关联线程', async () => {
    await mod.saveEventThreads([{
      title: '半导体景气',
      news_ids: [1],
      narrative: 'n',
      stage: 'early',
      confidence: 'high',
      related_industries: ['半导体'],
      key_watch_points: [],
    }]);
    const signal = await mod.getSignalById(1);
    expect(signal?.event_thread?.title).toBe('半导体景气');
  });

  it('getEventThreads 按成员新闻情绪给出看涨/看跌个股', async () => {
    const db = await mod.getDb();
    await db.execute({
      sql: 'INSERT INTO symbols (code, name, exchange, industry_l1, source_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: ['688981.SH', '中芯国际', 'SH', '半导体', 'test', new Date().toISOString()],
    });
    await db.execute({
      sql: `INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key, created_at)
            VALUES ('重点个股', ?, 'n', 'early', 'high', '重点个股', datetime('now'))`,
      args: [JSON.stringify([1, 2])],
    });

    const thread = (await mod.getEventThreads(24)).find((t) => t.title === '重点个股');
    // 中芯国际：利多 4 分 vs 利空 5 分，按信号分加权后归为看跌
    expect(thread?.focus_stocks.bullish).toEqual([]);
    expect(thread?.focus_stocks.bearish).toEqual([
      {
        name: '中芯国际',
        code: '688981.SH',
        reasons: [{ text: 's2', stance: 'negative' }],
      },
      {
        name: '长电科技',
        code: null,
        reasons: [{ text: 's2', stance: 'negative' }],
      },
    ]);
  });

  it('同一公司多空都有时按信号分权重决胜', async () => {
    const db = await mod.getDb();
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [3, 'test', 'n3', 't3', 'c3', new Date().toISOString()],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
            VALUES (3, 3, 5, 'industry', 'critical', ?, ?, 'positive', 's3')`,
      args: [JSON.stringify(['半导体']), JSON.stringify(['中芯国际'])],
    });
    await db.execute({
      sql: `INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key, created_at)
            VALUES ('权重决胜', ?, 'n', 'early', 'high', '权重决胜', datetime('now'))`,
      args: [JSON.stringify([1, 2, 3])],
    });

    const thread = (await mod.getEventThreads(24)).find((t) => t.title === '权重决胜');
    // 利多 4+5 > 利空 5
    expect(thread?.focus_stocks.bullish.map((s) => s.name)).toEqual(['中芯国际']);
    expect(thread?.focus_stocks.bearish.map((s) => s.name)).toEqual(['长电科技']);
  });

  it('混合/中性情绪不参与个股方向判断', async () => {
    const db = await mod.getDb();
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [4, 'test', 'n4', 't4', 'c4', new Date().toISOString()],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
            VALUES (4, 4, 5, 'industry', 'critical', ?, ?, 'mixed', 's4')`,
      args: [JSON.stringify(['半导体']), JSON.stringify(['方向不明公司'])],
    });
    await db.execute({
      sql: `INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key, created_at)
            VALUES ('分歧事件', ?, 'n', 'early', 'medium', '分歧事件', datetime('now'))`,
      args: [JSON.stringify([4])],
    });

    const thread = (await mod.getEventThreads(24)).find((t) => t.title === '分歧事件');
    expect(thread?.focus_stocks).toEqual({
      bullish: [],
      bearish: [],
      watch: [{
        name: '方向不明公司',
        code: null,
        reasons: [{ text: 's4', stance: 'mixed' }],
      }],
    });
  });

  it('重点个股依据优先取深度分析，且每个方向只留最强一条', async () => {
    const db = await mod.getDb();
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [3, 'test', 'n3', 't3', 'c3', new Date().toISOString()],
    });
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [4, 'test', 'n4', 't4', 'c4', new Date().toISOString()],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary, deep_analysis)
            VALUES (3, 3, 3, 'industry', 'moderate', ?, ?, 'positive', '摘要3', '深度依据3')`,
      args: [JSON.stringify(['半导体']), JSON.stringify(['中芯国际'])],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary, deep_analysis)
            VALUES (4, 4, 5, 'industry', 'critical', ?, ?, 'positive', '摘要4', '深度依据4')`,
      args: [JSON.stringify(['半导体']), JSON.stringify(['中芯国际'])],
    });
    await db.execute({
      sql: `INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key, created_at)
            VALUES ('依据优先级', ?, 'n', 'early', 'high', '依据优先级', datetime('now'))`,
      args: [JSON.stringify([1, 2, 3, 4])],
    });

    const thread = (await mod.getEventThreads(24)).find((t) => t.title === '依据优先级');
    expect(thread?.focus_stocks.bullish).toEqual([{
      name: '中芯国际',
      code: null,
      reasons: [{ text: '深度依据4', stance: 'positive' }],
    }]);
  });

  it('多空打平的待观察个股同时给出多空两边依据', async () => {
    const db = await mod.getDb();
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [5, 'test', 'n5', 't5', 'c5', new Date().toISOString()],
    });
    await db.execute({
      sql: 'INSERT INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [6, 'test', 'n6', 't6', 'c6', new Date().toISOString()],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
            VALUES (5, 5, 5, 'industry', 'critical', ?, ?, 'positive', '利多摘要')`,
      args: [JSON.stringify(['半导体']), JSON.stringify(['多空公司'])],
    });
    await db.execute({
      sql: `INSERT INTO analysis_result (id, news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
            VALUES (6, 6, 5, 'industry', 'critical', ?, ?, 'negative', '利空摘要')`,
      args: [JSON.stringify(['半导体']), JSON.stringify(['多空公司'])],
    });
    await db.execute({
      sql: `INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key, created_at)
            VALUES ('多空僵持', ?, 'n', 'early', 'medium', '多空僵持', datetime('now'))`,
      args: [JSON.stringify([5, 6])],
    });

    const thread = (await mod.getEventThreads(24)).find((t) => t.title === '多空僵持');
    expect(thread?.focus_stocks.watch).toEqual([{
      name: '多空公司',
      code: null,
      reasons: [
        { text: '利多摘要', stance: 'positive' },
        { text: '利空摘要', stance: 'negative' },
      ],
    }]);
  });

  it('getEventThreadById 关联表缺失时回退 news_ids', async () => {
    const db = await mod.getDb();
    await db.execute({
      sql: `INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key, created_at)
            VALUES ('回退测试', ?, 'n', 'early', 'high', '回退测试', datetime('now'))`,
      args: [JSON.stringify([1, 2])],
    });
    const threadRow = await db.execute({
      sql: "SELECT id FROM event_threads WHERE dedup_key = '回退测试'",
      args: [],
    });
    const threadId = Number(threadRow.rows[0].id);
    await db.execute({
      sql: 'DELETE FROM event_thread_signal WHERE thread_id = ?',
      args: [threadId],
    });
    const thread = await mod.getEventThreadById(threadId);
    expect(thread?.signals).toHaveLength(2);
    expect(thread?.signals.map((s) => s.id)).toEqual([1, 2]);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
