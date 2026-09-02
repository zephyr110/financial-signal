/**
 * Eastmoney sector index data fetcher.
 * Fetches daily quote for 申万 industry sector indices via the quote API.
 */
import { getDb, getBacktestByIndustry } from './db';

export type EventDirection = 'long' | 'short' | 'neutral' | 'mixed';

/**
 * 事件(日期×行业)极性聚合:当日 ≥3 分信号的 sentiment → 事件方向。
 * 规则:多空并存 → mixed;全 positive → long;全 negative → short;
 * 其余(全 neutral/mixed 或无信号情绪)→ neutral。
 * sentiment 为新闻级情绪,近似视为对所列行业同向影响(单情绪字段的已知近似)。
 */
export function polarizeEvent(sentiments: string[]): EventDirection {
  let longs = 0;
  let shorts = 0;
  for (const s of sentiments) {
    if (s === 'positive') longs++;
    else if (s === 'negative') shorts++;
  }
  if (longs > 0 && shorts > 0) return 'mixed';
  if (longs > 0) return 'long';
  if (shorts > 0) return 'short';
  return 'neutral';
}

const EM_QUOTE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';

// Major 申万行业 + 热门概念 sector codes (secid format: 90.BKxxxx)
// Verified against Eastmoney push2 API on 2026-07-29
const SECTOR_CODES = [
  // 行业板块 (t:2)
  'BK0479', // 钢铁
  'BK0438', // 食品饮料
  'BK1408', // 机器人
  'BK1277', // 白酒Ⅱ
  'BK1479', // 航空运输
  'BK1480', // 机场
  'BK1592', // 通信线缆及配套
  'BK1303', // 锂电池
  'BK1338', // 消费电子零部件及组装
  'BK1325', // 半导体材料
  'BK1317', // 光伏加工设备
  'BK1368', // 钢铁管材
  'BK1233', // 军工电子Ⅱ
  'BK1528', // 其他汽车零部件
  'BK1429', // 食品及饲料添加剂
  'BK1586', // 软饮料
  // 概念板块 (t:3)
  'BK0896', // 白酒
  'BK0490', // 军工
  'BK1106', // 创新药
  'BK0900', // 新能源车
  'BK1136', // 光通信模块
  'BK0480', // 航天航空
  'BK0574', // 锂电池概念
  'BK1646', // 消费电子概念
  'BK1184', // 人形机器人
  'BK0588', // 光伏概念
  'BK1121', // 第四代半导体
  'BK1164', // AIPC
  'BK0614', // 食品安全
];

/**
 * Fetch a single sector index quote. Never throws; returns [] on failure.
 */
async function fetchSectorQuote(code: string) {
  try {
    const params = new URLSearchParams({
      secid: `90.${code}`,
      fields: 'f43,f44,f45,f46,f47,f48,f57,f58,f169,f170',
    });
    const res = await fetch(`${EM_QUOTE_URL}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const d = json?.data;
    if (!d || d.f43 == null) return []; // f43 = latest price, skip if missing

    // Calculate change_pct from f169 (涨跌额) and f43 (最新价):
    //   prevClose = f43 - f169
    //   change_pct = f169 / prevClose * 100
    // This is mathematically correct regardless of f170 format.
    let changePct = null;
    if (d.f169 != null && d.f43 != null && d.f43 !== d.f169) {
      const prevClose = d.f43 - d.f169;
      if (prevClose > 0) {
        changePct = (d.f169 / prevClose) * 100;
      } else {
        console.warn(`[market] Invalid prevClose=${prevClose} for ${d.f58} (f43=${d.f43}, f169=${d.f169})`);
      }
    }
    // Log if value seems extreme (possible data corruption), but don't drop
    if (changePct != null && Math.abs(changePct) > 20) {
      console.warn(`[market] Large change for ${d.f58}: ${changePct.toFixed(2)}%`);
    }

    return [{
      code: d.f57,      // sector code
      name: d.f58,      // sector name
      type: 'index',    // sector index, not individual stock
      close: d.f43,     // latest price (or use f44=high, f45=low, f46=open)
      change_pct: changePct,
      volume: d.f47,    // volume
    }];
  } catch (err) {
    console.error(`[market] Failed to fetch ${code}:`, err.message);
    return [];
  }
}

/**
 * Fetch daily sector index quote data.
 * Uses secid=90.{code} to get the sector index itself (not constituent stocks).
 * 分片并发（每片 5 个）抓取 29 个板块：串行 30-60s → 并行 ~10s。
 */
export async function fetchMarketData() {
  const allRows = [];

  for (let i = 0; i < SECTOR_CODES.length; i += 5) {
    const chunk = SECTOR_CODES.slice(i, i + 5);
    const rows = await Promise.all(chunk.map(fetchSectorQuote));
    allRows.push(...rows.flat());
  }

  return allRows;
}

/**
 * Save market data to DB.
 */
export async function saveMarketData(rows) {
  const db = await getDb();
  const today = new Date().toISOString().slice(0, 10);
  let inserted = 0;
  for (const row of rows) {
    try {
      const result = await db.execute({
        sql: `INSERT OR REPLACE INTO market_data (code, name, type, trade_date, close, change_pct, volume)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [row.code, row.name, row.type, today, row.close, row.change_pct, row.volume],
      });
      inserted += result.rowsAffected || 0;
    } catch (err) {
      console.error(`[market] Insert error for ${row.code}:`, err.message);
    }
  }
  console.log(`[market] Saved ${inserted} rows for ${today}`);
  return inserted;
}

/**
 * 行业名 → 板块名别名映射（LLM 标注的申万行业名与东财板块名不完全一致时兜底）。
 * 仅在无直接匹配时启用（见 runBacktest），不会造成双计。
 */
const INDUSTRY_ALIASES: Record<string, string> = {
  '半导体': '半导体材料',
  '光模块': '光通信模块',
};

/**
 * Run backtest: correlate past signals with subsequent market returns.
 */
export async function runBacktest(daysBack = 30) {
  const db = await getDb();
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  // Get high-signal industries grouped by date
  const signals = await db.execute({
    sql: `
      SELECT DATE(n.published_at) as signal_date, a.industries, a.signal_score, a.sentiment
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ? AND a.signal_score >= 3 AND a.industries IS NOT NULL
      ORDER BY n.published_at
    `,
    args: [since],
  });

  // Group by (date, industry) and find max signal score + count + event direction
  const signalMap = new Map();
  for (const row of signals.rows) {
    let industries = [];
    try { industries = JSON.parse(row.industries); } catch { continue; }
    for (const ind of industries) {
      const key = `${row.signal_date}|${ind}`;
      const existing = signalMap.get(key);
      if (!existing || row.signal_score > existing.maxScore) {
        // 新条目或更高分信号替换条目:count/sentiments 均需带上此前累计(含本条)
        signalMap.set(key, {
          date: row.signal_date,
          industry: ind,
          maxScore: row.signal_score,
          count: (existing?.count || 0) + 1,
          sentiments: existing ? [...existing.sentiments, row.sentiment] : [row.sentiment],
        });
      } else if (existing) {
        existing.count++;
        existing.sentiments.push(row.sentiment);
      }
    }
  }

  // 一次拉取窗口内全部行情，内存中按行业索引——避免每个 (date, industry)
  // 键 2 次串行 DB 往返的 N+1 查询风暴（上千键 × 远端 DB 往返 = 数分钟超时）
  const market = await db.execute({
    sql: `SELECT name, trade_date, change_pct FROM market_data
          WHERE trade_date >= ?
          ORDER BY name, trade_date ASC`,
    args: [since.slice(0, 10)],
  });
  const marketByIndustry = new Map<string, Array<{ trade_date: string; change_pct: number | null }>>();
  for (const row of market.rows) {
    const list = marketByIndustry.get(row.name) || [];
    list.push({ trade_date: row.trade_date, change_pct: row.change_pct });
    marketByIndustry.set(row.name, list);
  }

  // Use INSERT OR REPLACE with UNIQUE(signal_date, industry) — atomic, no DELETE needed
  const upserts: Array<[string, string, number, number, EventDirection, number | null, number | null, number | null]> = [];
  for (const [, sig] of signalMap) {
    // 别名兜底：LLM 行业名与板块名不一致时映射到标准板块（仅无直接匹配时）
    let rows = marketByIndustry.get(sig.industry) || [];
    if (rows.length === 0 && INDUSTRY_ALIASES[sig.industry]) {
      rows = marketByIndustry.get(INDUSTRY_ALIASES[sig.industry]) || [];
    }
    const start = rows.findIndex((r) => r.trade_date > sig.date);
    const fwd = start >= 0 ? rows.slice(start, start + 7) : [];

    const day1 = fwd.length >= 1 ? fwd[0].change_pct : null;
    const day3 = fwd.length >= 3 ? fwd.slice(0, 3).reduce((s, r) => s + (r.change_pct ?? 0), 0) : null;
    const day7 = fwd.length >= 7 ? fwd.slice(0, 7).reduce((s, r) => s + (r.change_pct ?? 0), 0) : null;
    upserts.push([sig.date, sig.industry, sig.maxScore, sig.count, polarizeEvent(sig.sentiments), day1, day3, day7]);
  }

  // 批量写入（每批 50 行，仿 insertNewsBatch）
  for (let i = 0; i < upserts.length; i += 50) {
    const batch = upserts.slice(i, i + 50);
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const args = batch.flatMap(([date, industry, score, count, dir, d1, d3, d7]) => [date, industry, score, count, dir, d1, d3, d7]);
    await db.execute({
      sql: `INSERT OR REPLACE INTO backtest_result (signal_date, industry, signal_score, signal_count, direction, day_1_return, day_3_return, day_7_return) VALUES ${values}`,
      args,
    });
  }

  const stats = await db.execute({ sql: 'SELECT COUNT(*) as total FROM backtest_result', args: [] });
  console.log(`[backtest] Completed: ${stats.rows[0]?.total || 0} signal-market pairs analyzed`);
  return { pairs: stats.rows[0]?.total || 0 };
}

/**
 * Get the most recent trading day's sector quotes (for the market comparison panel).
 * Falls back to the latest available trade_date when today is a non-trading day.
 */
export async function getTodayMarketData(limit = 8) {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT name, close, change_pct FROM market_data
          WHERE trade_date = (SELECT MAX(trade_date) FROM market_data)
            AND change_pct IS NOT NULL
          ORDER BY ABS(change_pct) DESC
          LIMIT ?`,
    args: [Math.min(limit, 20)],
  });
  return result.rows;
}

/**
 * Get backtest summary grouped by signal score.
 */
export async function getBacktestSummary() {
  const db = await getDb();
  const [byScore, byIndustry] = await Promise.all([
    db.execute({
      sql: `SELECT signal_score,
              COUNT(*) as samples,
              COALESCE(ROUND(AVG(day_1_return), 2), 0) as avg_d1,
              COALESCE(ROUND(AVG(day_3_return), 2), 0) as avg_d3,
              COALESCE(ROUND(AVG(day_7_return), 2), 0) as avg_d7,
              ROUND(SUM(CASE WHEN (direction = 'long' AND day_1_return > 0) OR (direction = 'short' AND day_1_return < 0) THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END), 0), 1) as win_rate
            FROM backtest_result
            WHERE day_1_return IS NOT NULL
            GROUP BY signal_score
            ORDER BY signal_score DESC`,
    }),
    db.execute({
      sql: `SELECT industry, signal_score,
              COUNT(*) as samples,
              COALESCE(ROUND(AVG(day_1_return), 2), 0) as avg_d1,
              COALESCE(ROUND(AVG(day_3_return), 2), 0) as avg_d3,
              COALESCE(ROUND(AVG(day_7_return), 2), 0) as avg_d7,
              ROUND(SUM(CASE WHEN (direction = 'long' AND day_1_return > 0) OR (direction = 'short' AND day_1_return < 0) THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END), 0), 1) as win_rate
            FROM backtest_result
            WHERE day_1_return IS NOT NULL
            GROUP BY industry, signal_score
            HAVING COUNT(*) >= 3
            ORDER BY signal_score DESC, samples DESC`,
    }),
  ]);
  return { byScore: byScore.rows, byIndustry: byIndustry.rows };
}

/**
 * P2.4 线索页市场上下文：线程涉及行业的今日行情 + 近 30 天回测行。
 * 供 /api/thread/[id] 与 thread/[id].tsx SSG 共用（与 signal 详情页同构组装）。
 */
export async function getThreadMarketContext(industries: string[]) {
  const inds = Array.isArray(industries) ? industries : [];
  const [today, backtest] = await Promise.all([
    getTodayMarketData(20),
    getBacktestByIndustry(30),
  ]);
  const matches = (name: string | null | undefined) =>
    !!name && inds.some((ind: string) => name.includes(ind) || ind.includes(name));
  return {
    market: (today || []).filter((m) => matches(m.name as string | undefined)),
    backtest: (backtest || []).filter((b) => matches(b.industry as string | undefined)),
  };
}
