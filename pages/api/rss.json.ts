import { getArchivedNews } from '../../lib/db';
import { generateFeed } from '../../lib/generateFeed';

/**
 * JSON Feed (JSON Feed v1) 端点
 * GET /api/rss.json
 *
 * 与 rss.xml 一致：读归档库，避免订阅器轮询实时打上游。
 */
export default async function handler(req, res) {
  try {
    const rows = await getArchivedNews({ daysBack: 1, limit: 200 });
    const feed = generateFeed(rows);

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=1800, stale-while-revalidate'
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(feed.json1());
  } catch (error) {
    console.error('JSON feed error:', error);
    res.status(500).json({ error: 'Failed to generate feed' });
  }
}
