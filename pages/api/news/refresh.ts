import { archiveNews } from '../../../lib/archive';
import { analyzeUnanalyzedNews } from '../../../lib/analyze';
import { withPipelineRun } from '../../../lib/pipeline';

function insertedCount(counts: Record<string, number>): number {
  return Object.entries(counts).reduce(
    (sum, [key, value]) => key === 'duplicates' ? sum : sum + (Number(value) || 0),
    0
  );
}

/**
 * POST /api/news/refresh
 * 登录用户手动补新闻：抓取一次，再分析最新一批（默认 10 条）。
 * 只能由用户点击触发，避免页面自动轮询静默消耗 LLM；定时任务仍走 cron。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const batchId = `manual-${Date.now()}`;
    const counts = await withPipelineRun(
      'fetch',
      batchId,
      () => archiveNews(),
      insertedCount
    );
    const fetched = insertedCount(counts);
    const analysis = await withPipelineRun(
      'analyze',
      batchId,
      () => analyzeUnanalyzedNews(5, 2),
      (r) => r.analyzed
    );

    res.status(200).json({
      ok: true,
      fetched,
      duplicates: counts.duplicates || 0,
      analyzed: analysis.analyzed,
      errors: analysis.errors,
      hasMore: analysis.hasMore,
    });
  } catch (error) {
    console.error('[news/refresh] Error:', error);
    res.status(500).json({ error: '抓取或分析失败，请稍后重试' });
  }
}
