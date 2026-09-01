import { Feed } from 'feed';

/**
 * 根据新闻条目生成 RSS / JSON Feed。
 * 兼容两种条目形态：
 *  - 上游原始条目：{ id, rich_text, create_time, docurl }（Sina 直播流）
 *  - 归档库行：{ id, title, content, published_at, docurl }（lib/db getArchivedNews）
 */

/** 剥离 HTML 标签并截断，避免标题/摘要带标记语言。 */
function cleanText(value, max = 300) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 解析新闻时间：ISO 字符串直接解析；SQLite 无时区格式（'YYYY-MM-DD HH:MM:SS'）
 * 按上海时间解释（与上游 create_time 一致）；无法解析回退当前时间，绝不抛错。
 */
export function parseFeedDate(value) {
  if (!value) return new Date();
  const s = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)
    ? s.replace(' ', 'T') + '+08:00'
    : s;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * 根据新闻条目生成 RSS Feed
 * @param {Array} items - 新闻条目列表
 * @param {string} siteUrl - 站点根 URL（从环境变量 SITE_URL 读取）
 * @returns {Feed}
 */
export function generateFeed(items, siteUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_VERCEL_URL || 'http://localhost:3000') {
  const feed = new Feed({
    title: '财经信号',
    description: 'AI 驱动的财经新闻聚合与信号分析 — 新浪 7×24 全球实时快讯',
    link: siteUrl,
    language: 'zh-CN',
    generator: 'financial-signal',
    feedLinks: {
      json: `${siteUrl}/api/rss.json`,
      rss: `${siteUrl}/api/rss.xml`,
    },
  });

  for (const item of items || []) {
    const title = cleanText(item.rich_text || item.title || item.content, 300);
    if (!title) continue;
    feed.addItem({
      title,
      id: String(item.id),
      link: item.docurl || undefined,
      content: cleanText(item.content || '', 2000),
      date: parseFeedDate(item.create_time || item.published_at),
    });
  }

  return feed;
}
