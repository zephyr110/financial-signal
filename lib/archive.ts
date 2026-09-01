import { fetchNews } from './fetchNews';
import { insertNews, insertNewsBatch, logEvent, EVENT_TYPES } from './db';
import { FILTER_KEYWORDS } from './constants';
import { registerNewsSource, getActiveNewsSources, type NewsSourceProvider } from './providers';

// Eastmoney & CLS news APIs are currently unavailable (404/405 as of 2026-07).
// Infrastructure kept for when APIs are re-enabled. Sina remains the primary working source.
// See fetchEastmoneyNews() and fetchClsNews() — currently return [].

// --- Normalizers ---

/** Parse a date-like value to ISO string; fall back to now if invalid. */
function toIsoOrNow(value) {
  if (!value) return new Date().toISOString();
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function normalizeSinaItem(item) {
  const published = item.create_time
    ? toIsoOrNow(item.create_time.replace(' ', 'T') + '+08:00')
    : new Date().toISOString();
  // sina 直播流条目无独立 title 字段，标题包裹在 rich_text 的【】中
  const titleMatch = String(item.rich_text || '').match(/^【(.+?)】/);
  return {
    source: 'sina',
    source_id: String(item.id),
    title: titleMatch ? titleMatch[1] : null,
    content: item.rich_text,
    published_at: published,
    docurl: item.docurl || null,
  };
}

function normalizeEastmoneyItem(item) {
  return {
    source: 'eastmoney',
    source_id: String(item.code || `${item.showTime}_${item.title?.slice(0, 40)}`),
    title: item.title || null,
    content: item.content || '',
    published_at: toIsoOrNow(item.showTime),
  };
}

function normalizeClsItem(item) {
  return {
    source: 'cls',
    source_id: String(item.id || `${item.ctime}_${item.title?.slice(0, 30)}`),
    title: item.title || null,
    content: item.content || item.brief || '',
    published_at: toIsoOrNow(item.ctime),
  };
}

// --- Fetchers ---

async function fetchSinaNews() {
  try {
    const items = await fetchNews(); // reuse existing fetcher
    return items.flatMap((item) => {
      try {
        return [normalizeSinaItem(item)];
      } catch (err) {
        console.warn('Sina normalize skipped:', err.message);
        return [];
      }
    });
  } catch (err) {
    console.error('Sina fetch failed:', err.message);
    return [];
  }
}

// --- Unix timestamp helper: auto-detect seconds vs milliseconds ---
function parseUnixTs(ts) {
  if (!ts) return null;
  const num = Number(ts);
  if (!Number.isFinite(num)) return null;
  // If > 1e12, it's already in milliseconds (post year 33658)
  return new Date(num > 1e12 ? num : num * 1000);
}

// --- 同花顺 (10jqka) 7x24 flash news ---
async function fetch10jqkaNews() {
  try {
    const res = await fetch('https://news.10jqka.com.cn/tapp/news/push/stock/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`10jqka HTTP ${res.status}`);
    const json = await res.json();
    const list = json?.data?.list || [];
    return list
      .filter(item => {
        const txt = item.digest || item.title || '';
        if (!txt) return false;
        return !FILTER_KEYWORDS.some(kw => txt.includes(kw));
      })
      .flatMap(item => {
        try {
          const dt = parseUnixTs(item.ctime);
          return [{
            source: '10jqka',
            source_id: String(item.id),
            title: item.title || null,
            content: (item.digest || item.title || '').slice(0, 500),
            published_at: dt ? dt.toISOString() : new Date().toISOString(),
          }];
        } catch { return []; }
      });
  } catch (err) {
    console.error('10jqka fetch failed:', err.message);
    return [];
  }
}

// --- 华尔街见闻 (Wallstreetcn) live news ---
async function fetchWallstreetcnNews() {
  try {
    const res = await fetch('https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=20', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Wallstreetcn HTTP ${res.status}`);
    const json = await res.json();
    const list = json?.data?.items || [];
    return list
      .filter(item => {
        const txt = item.content_text || item.title || '';
        if (!txt) return false;
        return !FILTER_KEYWORDS.some(kw => txt.includes(kw));
      })
      .flatMap(item => {
        try {
          const dt = parseUnixTs(item.display_time);
          return [{
            source: 'wallstreetcn',
            source_id: String(item.id),
            title: item.title || null,
            content: (item.content_text || item.title || '').slice(0, 500),
            published_at: dt ? dt.toISOString() : new Date().toISOString(),
          }];
        } catch { return []; }
      });
  } catch (err) {
    console.error('Wallstreetcn fetch failed:', err.message);
    return [];
  }
}

async function fetchEastmoneyNews() {
  // Eastmoney news API deprecated (404 as of 2026-07). Placeholder for future re-enablement.
  return [];
}

async function fetchClsNews() {
  // CLS API returns HTML/requires signature (405 as of 2026-07). Placeholder for future re-enablement.
  return [];
}

// --- NewsSource seam: register providers (spec §10.2 原则1) ---
// 新增信源 = 实现 NewsSourceProvider 并 registerNewsSource(...)，无需改主流程。
// 配置级启停：环境变量 NEWS_SOURCES="sina,10jqka"（白名单），见 lib/providers.ts。

const providers: NewsSourceProvider[] = [
  { id: 'sina', name: '新浪 7×24', fetch: fetchSinaNews },
  { id: 'eastmoney', name: '东方财富快讯', fetch: fetchEastmoneyNews },
  { id: 'cls', name: '财联社', fetch: fetchClsNews },
  { id: '10jqka', name: '同花顺 7×24', fetch: fetch10jqkaNews },
  { id: 'wallstreetcn', name: '华尔街见闻', fetch: fetchWallstreetcnNews },
];
for (const p of providers) registerNewsSource(p);

// --- Main Archive Function ---

// 实时补数据的内存缓存:首页 /api/news 每次请求都会 fetchLiveNews,
// 无缓存时每次请求都打上游信源(订阅器/多客户端会打爆上游)。60s TTL 内复用。
const LIVE_CACHE_TTL_MS = 60_000;
let liveCache: { at: number; items: any[] } = { at: 0, items: [] };

/**
 * Fetch live news from all active sources without DB insertion.
 * Used by getStaticProps and /api/news for real-time supplement.
 * 60s TTL 内存缓存:同一实例内高频请求不再重复抓上游;抓取失败时
 * 回退到缓存(即使已过期),尽力保证首页可用。
 */
export async function fetchLiveNews() {
  const now = Date.now();
  if (now - liveCache.at < LIVE_CACHE_TTL_MS) return liveCache.items;

  const active = getActiveNewsSources();
  let results;
  try {
    results = await Promise.all(active.map((p) => p.fetch()));
  } catch (err) {
    console.error('[archive] live fetch failed, using stale cache:', err.message);
    if (liveCache.items.length > 0) return liveCache.items;
    throw err;
  }

  // Merge and normalize to a common format (matching what frontend expects)
  const all = [];
  for (const items of results) {
    for (const item of items) {
      all.push({ id: `${item.source}_${item.source_id}`, rich_text: item.content, published_at: item.published_at, source: item.source, title: item.title });
    }
  }

  // Sort by time desc
  all.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  liveCache = { at: now, items: all };
  return all;
}

export async function archiveNews() {
  const active = getActiveNewsSources();
  const counts = { duplicates: 0 };
  // 预填充 0：空结果/失败信源也计入统计，避免日志只含 >0 信源造成误导（C19）
  const sourceCounts: Record<string, number> = Object.fromEntries(active.map((p) => [p.id, 0]));

  // Fetch from all active sources in parallel
  const results = await Promise.all(active.map((p) => p.fetch()));

  for (let i = 0; i < active.length; i++) {
    const provider = active[i];
    const items = results[i];
    if (items.length === 0) continue;
    const inserted = await insertNewsBatch(items);
    sourceCounts[provider.id] = inserted;
    counts.duplicates += items.length - inserted;
    if (inserted > 0) {
      await logEvent(EVENT_TYPES.NEWS_INGESTED, {
        payload: { source: provider.id, count: inserted },
      });
    }
  }

  console.log(`[archive] ${Object.entries(sourceCounts).map(([k, v]) => `${k}=${v}`).join(' ')} dup=${counts.duplicates}`);
  return { ...counts, ...sourceCounts };
}
