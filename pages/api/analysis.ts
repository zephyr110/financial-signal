import { getAnalyzedNews, getAnalysisStatsWithComparison, getIndustryHeatmap, getIndustryTrend, getEventThreads, getCompanyHeatmap, getSentimentBreakdown } from '../../lib/db';
import { aggregateSentimentRows } from '../../lib/sentiment';
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

    const [news, statsComparison, heatmap, trend, threads, companyHeatmap, marketToday, sentimentRows] = await Promise.all([
      getAnalyzedNews({ minScore, hoursBack, limit: 50, cursor, industries }),
      getAnalysisStatsWithComparison(hoursBack, hoursBack, industries),
      getIndustryHeatmap(hoursBack, industries),
      getIndustryTrend(trendHours, industries),
      getEventThreads(hoursBack, 500, industries),
      getCompanyHeatmap(hoursBack, industries),
      getTodayMarketData(8),
      getSentimentBreakdown(hoursBack, industries),
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

    const sentimentBreakdown = aggregateSentimentRows(sentimentRows);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ items, stats, heatmap, trend, threads, nextCursor, sentimentBreakdown, companyHeatmap, marketToday });
  } catch (error) {
    console.error('Analysis API error:', error);
    res.status(500).json({ error: 'Failed to fetch analysis' });
  }
}
