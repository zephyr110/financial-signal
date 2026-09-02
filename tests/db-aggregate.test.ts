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

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
