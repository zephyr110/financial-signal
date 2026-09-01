import { getArchivedNews } from '../../lib/db';
import { generateFeed } from '../../lib/generateFeed';

/**
 * RSS 2.0 端点
 * GET /api/rss.xml
 *
 * 读归档库而非实时抓取上游：RSS 订阅器轮询频繁（可达每几分钟一次），
 * 每次请求实时抓新浪/同花顺会打爆上游且慢；新闻由 cron 定时归档，
 * 这里只读最近 1 天数据 + CDN/ISR 缓存。
 */
export default async function handler(req, res) {
  try {
    const rows = await getArchivedNews({ daysBack: 1, limit: 200 });
    const feed = generateFeed(rows);

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=1800, stale-while-revalidate'
    );
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.status(200).send(feed.rss2());
  } catch (error) {
    console.error('RSS XML feed error:', error);
    res.status(500).json({ error: 'Failed to generate feed' });
  }
}
