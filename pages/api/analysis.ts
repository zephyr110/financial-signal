import { getAnalyzedNews, getAnalysisStatsWithComparison, getIndustryHeatmap, getIndustryTrend, getEventThreads, getCompanyHeatmap } from '../../lib/db';
import { getTodayMarketData } from '../../lib/market';
import { safeParse } from '../../lib/utils';

function clampInt(value: any, fallback: number, min: number, max: number): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * GET /api/analysis?hoursBack=24&minScore=1&trendHours=168&cursor=0
 * cursor: pagination cursor (last analysis_result.id from previous page)
 */
export default async function handler(req: any, res: any) {
  try {
    const hoursBack = clampInt(req.query.hoursBack, 24, 1, 720);
    const trendHours = clampInt(req.query.trendHours, hoursBack, 1, 8760);
    const minScore = clampInt(req.query.minScore, 1, 1, 5);
    const cursor = clampInt(req.query.cursor, 0, 0, 9999999);
    // 关注行业(逗号分隔,归一板块名):非空时全页数据统一按行业过滤(概览/情感/热力/趋势/线索/公司/列表)
    const watchedParam = Array.isArray(req.query.watched) ? req.query.watched[0] : req.query.watched;
    const industries: string[] | null = typeof watchedParam === 'string' && watchedParam.length > 0
      ? watchedParam.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30)
      : null;

    const [news, statsComparison, heatmap, trend, threads, companyHeatmap, marketToday] = await Promise.all([
      getAnalyzedNews({ minScore, hoursBack, limit: 50, cursor, industries }),
      getAnalysisStatsWithComparison(hoursBack, hoursBack, industries),
      getIndustryHeatmap(hoursBack, industries),
      getIndustryTrend(trendHours, industries),
      getEventThreads(hoursBack, 500, industries),
      getCompanyHeatmap(hoursBack, industries),
      getTodayMarketData(8),
    ]);

    const stats = {
      ...statsComparison.current,
      previous: statsComparison.previous,
    };

    const items = news.map((item: any) => ({
      ...item,
      industries: item.industries ? safeParse(item.industries) : [],
      companies: item.companies ? safeParse(item.companies) : [],
      tags: item.tags ? safeParse(item.tags) : [],
    }));

    // Next cursor is the smallest analysis_result.id in this batch
    const nextCursor = items.length === 50 ? items[items.length - 1].id : null;

    // Compute sentiment breakdown by category (only score >= 3)
    const sentimentBreakdown = computeSentimentBreakdown(items);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ items, stats, heatmap, trend, threads, nextCursor, sentimentBreakdown, companyHeatmap, marketToday });
  } catch (error) {
    console.error('Analysis API error:', error);
    res.status(500).json({ error: 'Failed to fetch analysis' });
  }
}

/**
 * Compute sentiment distribution by category for signals with score >= 3.
 */
function computeSentimentBreakdown(items: any[]) {
  const categories = ['policy', 'geopolitics', 'industry', 'company', 'macro', 'market_rumor'];
  const sentiments = ['positive', 'negative', 'neutral', 'mixed'];

  const result: Record<string, Record<string, number>> = {};
  for (const cat of categories) {
    result[cat] = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  }

  for (const item of items) {
    if (item.signal_score == null || item.signal_score < 3) continue;
    const cat = item.category || 'macro';
    const sent = item.sentiment || 'neutral';
    if (result[cat] && result[cat][sent] !== undefined) {
      result[cat][sent]++;
    }
  }

  return categories
    .map((cat) => ({
      category: cat,
      ...result[cat],
    }))
    .filter((d: any) => d.positive + d.negative + d.neutral + d.mixed > 0);
}
