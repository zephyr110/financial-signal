import { getBacktestSummary } from '../../lib/market';

/**
 * Public API: returns backtest summary grouped by signal score.
 * GET /api/backtest
 */
export default async function handler(req, res) {
  try {
    const { byScore, byIndustry, pending } = await getBacktestSummary();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.status(200).json({ byScore, byIndustry, pending });
  } catch (error) {
    console.error('Backtest API error:', error);
    res.status(500).json({ error: 'Failed to fetch backtest data' });
  }
}
