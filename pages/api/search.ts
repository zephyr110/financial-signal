import { searchSignals } from '../../lib/db';

/**
 * GET /api/search
 *
 * Full-text search across signals. Searches content, summary,
 * deep_analysis, industries, and companies fields.
 *
 * Query params:
 *   q          - search keyword (required, >= 2 chars)
 *   minScore   - minimum signal score filter (default 1)
 *   hoursBack  - time window in hours (default 168, max 2160)
 *   cursor     - pagination offset (default 0)
 *   limit      - results per page (default 20, max 50)
 */
export default async function handler(req, res) {
  const { q, minScore, hoursBack, cursor, limit } = req.query;

  const query = String(q || '').trim();

  if (!query || query.length < 2) {
    return res.status(400).json({
      error: '搜索关键词至少需要 2 个字符',
    });
  }

  try {
    const parsedMinScore = Number(minScore);
    const parsedHoursBack = Number(hoursBack);
    const parsedCursor = cursor ? Number(cursor) : undefined;
    const parsedLimit = limit ? Number(limit) : 20;

    const result = await searchSignals({
      query,
      minScore: Number.isFinite(parsedMinScore) ? parsedMinScore : 1,
      hoursBack: Number.isFinite(parsedHoursBack) ? parsedHoursBack : 168,
      cursor: Number.isFinite(parsedCursor) ? parsedCursor : undefined,
      limit: Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 50)) : 20,
    });

    res.setHeader(
      'Cache-Control',
      's-maxage=120, stale-while-revalidate=60',
    );
    res.status(200).json(result);
  } catch (error) {
    console.error('[api/search] Error:', error);
    res.status(500).json({ error: '搜索失败，请稍后重试' });
  }
}
