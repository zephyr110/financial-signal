/**
 * Eastmoney sector index data fetcher.
 * Fetches daily quote for 申万 industry sector indices via the quote API.
 */
import { getDb, getBacktestByIndustry } from './db';
import { cachedRead, readCacheKey, READ_CACHE_TTL, clearReadCache } from './read-cache';
import { INDUSTRY_ALIASES } from './constants';
import { todayShanghai } from './cockpit/format';

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

// 搜索接口把行业名解析成东方财富板块代码；静态表覆盖不到的行业靠它补齐
const EM_SUGGEST_URL = 'https://searchapi.eastmoney.com/api/suggest/get';
const EM_SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';
const RESOLVED_SECTORS_KEY = 'market_sector_codes_v1';
const SECTOR_MISSES_KEY = 'market_sector_misses_v1';
/** 每轮最多解析的新行业数，避免一次 cron 打爆搜索接口 */
const RESOLVE_LIMIT = 40;
/** 解析失败后的冷却期；否则永不命中的行业名会占满每轮名额，后面的新行业永远轮不到 */
const MISS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

// 行业名与板块名不同名时先换成可搜索的词，再走解析（结果仍按原行业名缓存）
const SECTOR_SEARCH_ALIASES: Record<string, string> = {
  新能源汽车: '新能源车',
  风电: '风电设备',
  化工: '化工原料',
  软件服务: '软件开发',
  资本市场服务: '证券',
};

interface SectorBoard {
  code: string;
  name: string;
}

type ResolvedSectorMap = Record<string, SectorBoard>;
type SectorMissMap = Record<string, string>;

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

/** 从搜索建议里挑板块：同名优先，其次名称互相包含且最短（最接近），其余不猜。 */
export function pickSectorBoard(
  name: string,
  rows: Array<{ Classify?: string; Code?: string; Name?: string }>,
): SectorBoard | null {
  const boards = rows.filter(
    (row) => row?.Classify === 'BK' && typeof row.Code === 'string' && typeof row.Name === 'string',
  ) as Array<{ Code: string; Name: string }>;
  if (boards.length === 0) return null;
  const exact = boards.find((row) => row.Name === name);
  // 取最短包含名：suggest 的前序结果常是概念板块，「锂电」应落到「锂电池」而非「锂电池概念」
  const contains = boards
    .filter((row) => row.Name.includes(name) || name.includes(row.Name))
    .sort((a, b) => a.Name.length - b.Name.length)[0];
  const pick = exact || contains;
  return pick ? { code: pick.Code, name: pick.Name } : null;
}

/** 行业名与板块名是否指同一板块；申万二级名常带 Ⅱ/Ⅲ 后缀，双向包含即可。 */
export function industryMatches(name: string, industries: string[]): boolean {
  const board = name.trim();
  if (!board) return false;
  return industries.some((raw) => {
    const ind = String(raw || '').trim();
    return !!ind && (board.includes(ind) || ind.includes(board));
  });
}

/**
 * 挑出线索涉及行业的当日行情。
 * 能解析到板块代码的行业只认代码（软件服务→软件开发 这类不同名映射），
 * 否则名称包含会把「新能源」顺带匹配成「新能源车」，多出无关板块。
 */
export function selectThreadMarket<T extends { code?: unknown; name?: unknown }>(
  rows: T[],
  industries: string[],
  resolved: Record<string, { code: string; name?: string }>,
): T[] {
  const inds = industries.map((ind) => String(ind || '').trim()).filter(Boolean);
  if (inds.length === 0) return [];
  const matchedCodes = new Set(
    inds.map((ind) => resolved[ind]?.code).filter((code): code is string => !!code),
  );
  const presentCodes = new Set(rows.map((m) => String(m.code ?? '')));
  // 已解析板块当天缺行情时，只按该板块自己的名字兜底；退回双向包含会带出兄弟板块
  const missingBoards = inds
    .map((ind) => resolved[ind])
    .filter((board): board is { code: string; name?: string } => !!board && !presentCodes.has(board.code));
  const unresolved = inds.filter((ind) => !resolved[ind]);
  const bare = (name: string) => name.replace(/[ⅡⅢ]+$/, '').trim();
  return rows.filter((m) => {
    if (matchedCodes.has(String(m.code ?? ''))) return true;
    const name = String(m.name ?? '');
    if (missingBoards.some((board) => board.name && bare(name) === bare(board.name))) return true;
    return industryMatches(name, unresolved);
  });
}

/** null = 搜索成功但无匹配板块；undefined = 请求失败（不能当作「无此板块」写负缓存）。 */
async function resolveSectorBoard(name: string): Promise<SectorBoard | null | undefined> {
  try {
    const query = SECTOR_SEARCH_ALIASES[name] || name;
    const params = new URLSearchParams({
      input: query,
      type: '14',
      token: EM_SUGGEST_TOKEN,
      count: '5',
    });
    const res = await fetch(`${EM_SUGGEST_URL}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return pickSectorBoard(query, json?.QuotationCodeTable?.Data || []);
  } catch (err) {
    console.warn(`[market] 解析行业板块失败 ${name}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

/**
 * 已解析的行业→板块映射；读失败时抛错而不是返回空表：
 * 空表会被缓存、还会被 fetchMarketData 当作底稿覆盖掉持久映射。
 */
async function loadResolvedSectors(): Promise<ResolvedSectorMap> {
  return cachedRead(readCacheKey(['marketSectorMap']), READ_CACHE_TTL.analysisAgg, async () => {
    const db = await getDb();
    const res = await db.execute({
      sql: 'SELECT value FROM app_settings WHERE key = ?',
      args: [RESOLVED_SECTORS_KEY],
    });
    const raw = res.rows[0]?.value;
    if (typeof raw !== 'string' || !raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ResolvedSectorMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const board = value as Partial<SectorBoard> | null;
      if (board && typeof board.code === 'string' && typeof board.name === 'string') {
        out[key] = { code: board.code, name: board.name };
      }
    }
    return out;
  });
}

async function saveResolvedSectors(map: ResolvedSectorMap): Promise<void> {
  try {
    const db = await getDb();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
      args: [RESOLVED_SECTORS_KEY, JSON.stringify(map), new Date().toISOString()],
    });
    clearReadCache('marketSectorMap');
  } catch (err) {
    console.warn('[market] 保存行业板块映射失败:', err instanceof Error ? err.message : err);
  }
}

/** 解析失败的行业 → 首次失败时间；冷却期内跳过，避免每轮重复打搜索接口。 */
async function loadSectorMisses(): Promise<SectorMissMap> {
  try {
    const db = await getDb();
    const res = await db.execute({
      sql: 'SELECT value FROM app_settings WHERE key = ?',
      args: [SECTOR_MISSES_KEY],
    });
    const raw = res.rows[0]?.value;
    if (typeof raw !== 'string' || !raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SectorMissMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) out[key] = value;
    }
    return out;
  } catch (err) {
    console.warn('[market] 读取行业解析 misses 失败:', err instanceof Error ? err.message : err);
    return {};
  }
}

async function saveSectorMisses(map: SectorMissMap): Promise<void> {
  try {
    const db = await getDb();
    await db.execute({
      sql: 'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
      args: [SECTOR_MISSES_KEY, JSON.stringify(map), new Date().toISOString()],
    });
  } catch (err) {
    console.warn('[market] 保存行业解析 misses 失败:', err instanceof Error ? err.message : err);
  }
}

/** 线索与信号里出现过的行业名；市场反应面板需要它们对应的板块行情。 */
async function collectIndustryNames(): Promise<string[]> {
  try {
    const db = await getDb();
    const res = await db.execute({
      sql: `SELECT DISTINCT value AS name FROM event_threads, json_each(event_threads.industries)
            WHERE event_threads.industries IS NOT NULL AND json_valid(event_threads.industries)
            UNION
            SELECT DISTINCT value AS name FROM analysis_result, json_each(analysis_result.industries)
            WHERE analysis_result.industries IS NOT NULL AND json_valid(analysis_result.industries)`,
      args: [],
    });
    return res.rows
      .map((row) => String(row.name ?? '').trim())
      .filter((name) => name.length >= 2 && name.length <= 20);
  } catch (err) {
    console.warn('[market] 读取行业名失败:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Fetch daily sector index quote data.
 * Uses secid=90.{code} to get the sector index itself (not constituent stocks).
 * 静态表覆盖 29 个常用板块；其余行业按需解析成板块代码后一并抓取，
 * 否则线索页「市场反应」只对少数板块有数据。
 */
export async function fetchMarketData() {
  const allRows: Array<Record<string, unknown>> = [];

  let staticCount = 0;
  for (let i = 0; i < SECTOR_CODES.length; i += 5) {
    const chunk = SECTOR_CODES.slice(i, i + 5);
    const rows = (await Promise.all(chunk.map(fetchSectorQuote))).flat();
    staticCount += rows.length;
    allRows.push(...rows);
  }
  // 静态板块全挂多半是上游故障：返回空让 cron 记失败重试，也避免动态板块把故障掩盖成成功
  if (staticCount === 0) {
    console.warn('[market] 静态板块全部抓取失败，跳过动态解析');
    return [];
  }

  // 读缓存共享同一对象，写入前先拷贝；读失败则本轮不做解析，避免用空表覆盖持久映射
  let resolvedBase: ResolvedSectorMap | null = null;
  try {
    resolvedBase = { ...(await loadResolvedSectors()) };
  } catch (err) {
    console.warn('[market] 读取行业板块映射失败，本轮跳过动态解析:', err instanceof Error ? err.message : err);
  }
  const [misses, industries] = await Promise.all([loadSectorMisses(), collectIndustryNames()]);

  if (resolvedBase) {
    const resolved = resolvedBase;
    const now = Date.now();
    const pending = industries
      .filter((name) => !resolved[name])
      .filter((name) => {
        const at = Date.parse(misses[name] || '');
        return !Number.isFinite(at) || now - at > MISS_RETRY_MS;
      })
      .slice(0, RESOLVE_LIMIT);
    let added = false;
    let missesChanged = false;
    for (let i = 0; i < pending.length; i += 5) {
      const chunk = pending.slice(i, i + 5);
      const boards = await Promise.all(chunk.map(resolveSectorBoard));
      boards.forEach((board, index) => {
        const name = chunk[index];
        // 请求失败不写负缓存，下轮重试；只有「搜索成功但确实没有板块」才冷却 7 天
        if (board === undefined) return;
        if (board === null) {
          misses[name] = new Date(now).toISOString();
          missesChanged = true;
          return;
        }
        if (misses[name] !== undefined) {
          delete misses[name];
          missesChanged = true;
        }
        resolved[name] = board;
        added = true;
      });
    }
    if (added) await saveResolvedSectors(resolved);
    if (missesChanged) await saveSectorMisses(misses);

    // 只抓当前仍被线索/信号引用的行业：resolved 只增不减，全量重抓会随历史线性变慢
    const staticCodes = new Set(SECTOR_CODES);
    const referenced = new Set(industries);
    const dynamicCodes = Array.from(
      new Set(
        Object.entries(resolved)
          .filter(([name, board]) => referenced.has(name) && !staticCodes.has(board.code))
          .map(([, board]) => board.code),
      ),
    );
    for (let i = 0; i < dynamicCodes.length; i += 5) {
      const chunk = dynamicCodes.slice(i, i + 5);
      const rows = await Promise.all(chunk.map(fetchSectorQuote));
      allRows.push(...rows.flat());
    }
  }

  return allRows;
}

/**
 * Save market data to DB.
 */
export async function saveMarketData(rows) {
  const db = await getDb();
  // UTC 日期在北京时间 00:00–08:00 会落到前一天，板块快照与简报交易日就对不上。
  const today = todayShanghai();
  let inserted = 0;
  // 批量写入(每批 50,仿 insertNewsBatch):29 个板块逐条往返 → 1 次/批
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const args = batch.flatMap((row) => [
      row.code, row.name, row.type, today, row.close, row.change_pct, row.volume,
    ]);
    try {
      const result = await db.execute({
        sql: `INSERT OR REPLACE INTO market_data (code, name, type, trade_date, close, change_pct, volume)
              VALUES ${values}`,
        args,
      });
      inserted += result.rowsAffected || 0;
    } catch (err) {
      console.error(`[market] Batch insert error:`, err.message);
    }
  }
  // 写后失效行情读缓存(否则 getTodayMarketData 要等 TTL 过后才展示新数据)
  if (inserted > 0) {
    clearReadCache('marketToday');
    clearReadCache('marketLatest');
  }
  console.log(`[market] Saved ${inserted} rows for ${today}`);
  return inserted;
}

/**
 * Run backtest: correlate past signals with subsequent market returns.
 * 行业名 → 板块名兜底映射见 lib/constants.ts INDUSTRY_ALIASES(仅无直接匹配时启用,不会双计)。
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
    sql: `SELECT code, name, trade_date, change_pct FROM market_data
          WHERE trade_date >= ?
          ORDER BY trade_date ASC, code, name`,
    args: [since.slice(0, 10)],
  });
  const marketByIndustry = new Map<string, Array<{ trade_date: string; change_pct: number | null }>>();
  const marketByCode = new Map<string, Array<{ trade_date: string; change_pct: number | null }>>();
  for (const row of market.rows) {
    const point = { trade_date: row.trade_date, change_pct: row.change_pct };
    const byName = marketByIndustry.get(row.name) || [];
    byName.push(point);
    marketByIndustry.set(row.name, byName);
    const byCode = marketByCode.get(row.code) || [];
    byCode.push(point);
    marketByCode.set(row.code, byCode);
  }
  // 读取失败只影响代码兜底，名称直配仍然可用
  const resolved = await loadResolvedSectors().catch(() => ({}));

  // Use INSERT OR REPLACE with UNIQUE(signal_date, industry) — atomic, no DELETE needed
  const upserts: Array<[string, string, number, number, EventDirection, number | null, number | null, number | null]> = [];
  for (const [, sig] of signalMap) {
    // 名称直配 → 已解析板块代码 → 别名兜底；任一层命中即用，避免重复计入。
    let rows = marketByIndustry.get(sig.industry) || [];
    if (rows.length === 0 && resolved[sig.industry]) {
      rows = marketByCode.get(resolved[sig.industry].code) || [];
    }
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

  // 清理超窗行:回测只承诺展示最近 daysBack 天,旧行不删会与「近 30 天」文案漂移
  // (且 v5 迁移前的遗留行 direction 为 NULL,清理后窗口内行下次重建时全部带方向)
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.execute({
    sql: 'DELETE FROM backtest_result WHERE signal_date < ?',
    args: [cutoff],
  });

  const stats = await db.execute({ sql: 'SELECT COUNT(*) as total FROM backtest_result', args: [] });
  console.log(`[backtest] Completed: ${stats.rows[0]?.total || 0} signal-market pairs analyzed`);
  return { pairs: stats.rows[0]?.total || 0 };
}

/**
 * Get the most recent trading day's sector quotes (for the market comparison panel).
 * Falls back to the latest available trade_date when today is a non-trading day.
 */
export async function getTodayMarketData(limit = 8) {
  const safeLimit = Math.min(limit, 20);
  const curated = SECTOR_CODES.map(() => '?').join(', ');
  return cachedRead(
    readCacheKey(['marketToday', safeLimit]),
    READ_CACHE_TTL.analysisAgg,
    async () => {
  const db = await getDb();
  // 只看精选板块：动态解析出的概念板块进同一张表，按涨幅截断会挤掉原来的主流板块
  const result = await db.execute({
    sql: `SELECT name, close, change_pct FROM market_data
          WHERE trade_date = (SELECT MAX(trade_date) FROM market_data)
            AND change_pct IS NOT NULL
            AND code IN (${curated})
          ORDER BY ABS(change_pct) DESC
          LIMIT ?`,
    args: [...SECTOR_CODES, safeLimit],
  });
  return result.rows;
    },
  );
}

/** 最新交易日的全部板块行情；线索页按行业筛选，不能先截断再筛（会漏掉冷门行业）。 */
export async function getLatestMarketData() {
  return cachedRead(
    readCacheKey(['marketLatest']),
    READ_CACHE_TTL.analysisAgg,
    async () => {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT code, name, change_pct FROM market_data
          WHERE trade_date = (SELECT MAX(trade_date) FROM market_data)
            AND change_pct IS NOT NULL
          ORDER BY name`,
    args: [],
  });
  return result.rows;
    },
  );
}

/**
 * Get backtest summary grouped by signal score.
 */
export async function getBacktestSummary() {
  const db = await getDb();
  const [byScore, byIndustry, pending] = await Promise.all([
    db.execute({
      sql: `SELECT signal_score,
              COUNT(*) as samples,
              COALESCE(ROUND(AVG(day_1_return), 2), 0) as avg_d1,
              COALESCE(ROUND(AVG(day_3_return), 2), 0) as avg_d3,
              COALESCE(ROUND(AVG(day_7_return), 2), 0) as avg_d7,
              SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END) as directional_count,
              ROUND(SUM(CASE WHEN (direction = 'long' AND day_1_return > 0) OR (direction = 'short' AND day_1_return < 0) THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END), 0), 1) as win_rate
            FROM backtest_result
            WHERE day_1_return IS NOT NULL
              AND signal_date >= date('now', '-30 day')
            GROUP BY signal_score
            ORDER BY signal_score DESC`,
    }),
    db.execute({
      sql: `SELECT industry, signal_score,
              COUNT(*) as samples,
              COALESCE(ROUND(AVG(day_1_return), 2), 0) as avg_d1,
              COALESCE(ROUND(AVG(day_3_return), 2), 0) as avg_d3,
              COALESCE(ROUND(AVG(day_7_return), 2), 0) as avg_d7,
              SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END) as directional_count,
              ROUND(SUM(CASE WHEN (direction = 'long' AND day_1_return > 0) OR (direction = 'short' AND day_1_return < 0) THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END), 0), 1) as win_rate
            FROM backtest_result
            WHERE day_1_return IS NOT NULL
              AND signal_date >= date('now', '-30 day')
            GROUP BY industry, signal_score
            HAVING COUNT(*) >= 3
            ORDER BY signal_score DESC, samples DESC`,
    }),
    // 已入库但尚无 T+1 行情可算的信号数：用于空态说明「在等行情」，而非看起来像没跑过
    db.execute({
      sql: `SELECT COUNT(*) as pending
            FROM backtest_result
            WHERE day_1_return IS NULL
              AND signal_date >= date('now', '-30 day')`,
    }),
  ]);
  return {
    byScore: byScore.rows,
    byIndustry: byIndustry.rows,
    pending: Number(pending.rows[0]?.pending ?? 0),
  };
}

/**
 * P2.4 线索页市场上下文：线程涉及行业的今日行情 + 近 30 天回测行。
 * 供 /api/thread/[id] 与 thread/[id].tsx SSG 共用（与 signal 详情页同构组装）。
 */
export async function getThreadMarketContext(industries: string[]) {
  const inds = Array.isArray(industries) ? industries.map((ind) => String(ind || '')).filter(Boolean) : [];
  const [today, backtest, resolved] = await Promise.all([
    getLatestMarketData(),
    getBacktestByIndustry(30),
    loadResolvedSectors().catch(() => ({})),
  ]);
  return {
    market: selectThreadMarket(today || [], inds, resolved),
    // 回测行存的是信号里的原始行业名，按名称匹配
    backtest: (backtest || []).filter((b) => industryMatches(String(b.industry ?? ''), inds)),
  };
}
