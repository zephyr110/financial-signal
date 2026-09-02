import path from 'path';
import os from 'os';
import fs from 'fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@libsql/client';
import { polarizeEvent } from '../lib/market';

/**
 * 方向命中率(v5):事件极性聚合 + 方向化胜率公式的语义测试。
 *  - polarizeEvent:纯函数,规则 = 多空并存→mixed / 全 positive→long / 全 negative→short / 其余→neutral
 *  - SQL 公式:命中 = (long 且次日涨)或(short 且次日跌);分母仅 long/short;
 *    中性/混合/遗留 NULL 不计入;分母为 0 时结果 NULL(NULLIF)。
 * 注:测试中的 CASE 片段与 lib/db.ts getBacktestByIndustry、lib/market.ts
 * getBacktestSummary 中的公式保持一致——若公式变更请同步更新本文件。
 */

describe('polarizeEvent 事件极性聚合', () => {
  it('全 positive → long', () => {
    expect(polarizeEvent(['positive', 'positive'])).toBe('long');
  });
  it('全 negative → short', () => {
    expect(polarizeEvent(['negative'])).toBe('short');
  });
  it('多空并存 → mixed(即使 neutral 掺入)', () => {
    expect(polarizeEvent(['positive', 'negative'])).toBe('mixed');
    expect(polarizeEvent(['positive', 'negative', 'neutral'])).toBe('mixed');
  });
  it('neutral/mixed 情绪 → neutral(不赌方向)', () => {
    expect(polarizeEvent(['neutral', 'neutral'])).toBe('neutral');
    expect(polarizeEvent(['mixed'])).toBe('neutral');
    expect(polarizeEvent([])).toBe('neutral');
  });
  it('positive 与 neutral 并存 → long(中性不抵消)', () => {
    expect(polarizeEvent(['positive', 'neutral', 'mixed'])).toBe('long');
    expect(polarizeEvent(['negative', 'neutral'])).toBe('short');
  });
});

// ── 公式语义(独立临时 libsql 库,不含任何业务表,隔离运行) ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-direction-test-'));
const db = createClient({ url: `file:${dir}/bt.db` });

// 与 lib/db.ts:1410 同款公式(缩进/别名已对齐,便于 diff 对照)
const WIN_RATE_SQL = `
  SELECT industry,
         COUNT(*) as samples,
         ROUND(SUM(CASE WHEN (direction = 'long' AND day_1_return > 0) OR (direction = 'short' AND day_1_return < 0) THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END), 0), 1) as win_rate
  FROM backtest_result
  WHERE day_1_return IS NOT NULL
  GROUP BY industry
  ORDER BY industry`;

beforeAll(async () => {
  await db.executeMultiple(`
    CREATE TABLE backtest_result (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_date   TEXT NOT NULL,
      industry      TEXT NOT NULL,
      signal_score  INTEGER NOT NULL,
      signal_count  INTEGER NOT NULL,
      direction     TEXT,
      day_1_return  REAL,
      calculated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // 行业 A:3 long(2 涨 1 跌)+ 2 short(1 跌 1 涨)→ 命中 3/5 = 60
  // 行业 B:1 long(涨)+ 1 neutral + 1 mixed + 1 遗留 NULL → 命中 1/1 = 100(分母只计 long)
  // 行业 C:仅 neutral/mixed/NULL → 分母 0 → win_rate NULL
  await db.executeMultiple(`
    INSERT INTO backtest_result (signal_date, industry, signal_score, signal_count, direction, day_1_return) VALUES
      ('2026-08-01', 'A', 4, 2, 'long',    1.2),
      ('2026-08-02', 'A', 4, 1, 'long',    -0.8),
      ('2026-08-03', 'A', 5, 1, 'long',    0.5),
      ('2026-08-04', 'A', 4, 1, 'short',   -1.1),
      ('2026-08-05', 'A', 4, 1, 'short',    0.3),
      ('2026-08-06', 'B', 4, 1, 'long',    2.0),
      ('2026-08-07', 'B', 4, 1, 'neutral', 1.0),
      ('2026-08-08', 'B', 4, 1, 'mixed',   -1.0),
      ('2026-08-09', 'B', 4, 1, NULL,      0.6),
      ('2026-08-10', 'C', 4, 1, 'neutral', 1.5),
      ('2026-08-11', 'C', 4, 1, 'mixed',   -0.5),
      ('2026-08-12', 'C', 4, 1, NULL,      0.2)
  `);
});

afterAll(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('方向化胜率公式语义', () => {
  it('A:long 命中 2 + short 命中 1(空头次日跌为胜)/ 分母 5 → 60.0', async () => {
    const r = await db.execute({ sql: WIN_RATE_SQL, args: [] });
    const rows = r.rows as any[];
    const a = rows.find((x) => x.industry === 'A');
    expect(a.samples).toBe(5); // 总事件数,含 short 上涨的失败样本
    expect(a.win_rate).toBe(60.0);
  });
  it('B:分母只计 long(neutral/mixed/NULL 不入),命中 1/1 → 100.0;samples 含全部 4 行', async () => {
    const r = await db.execute({ sql: WIN_RATE_SQL, args: [] });
    const rows = r.rows as any[];
    const b = rows.find((x) => x.industry === 'B');
    expect(b.samples).toBe(4);
    expect(b.win_rate).toBe(100.0);
  });
  it('C:无任何方向事件 → 分母 0,win_rate 为 NULL(不除零崩溃)', async () => {
    const r = await db.execute({ sql: WIN_RATE_SQL, args: [] });
    const rows = r.rows as any[];
    const c = rows.find((x) => x.industry === 'C');
    expect(c.samples).toBe(3);
    expect(c.win_rate).toBeNull();
  });
  it('short 事件次日上涨不计胜(A 的 short +0.3 行被正确排除)', async () => {
    const r = await db.execute({ sql: WIN_RATE_SQL, args: [] });
    const rows = r.rows as any[];
    const a = rows.find((x) => x.industry === 'A');
    // 若 short 上涨误计胜,命中会是 4/5=80;60 证明 short 只看方向
    expect(a.win_rate).toBe(60.0);
  });
});
