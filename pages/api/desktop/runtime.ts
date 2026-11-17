import { getEffectiveLlmConfig } from '../../../lib/llm/config';
import { isLocalOrigin } from '../../../lib/cronAuth';

/**
 * 桌面端内置调度器的运行时状态（仅本机请求）。
 * 调度器每轮据此决定是否触发 LLM 任务；Turso 模式下本地库读不到当前设置，
 * 因此不能再用 electron/app-settings 直读 SQLite。
 */
export default async function handler(req: any, res: any) {
  if (process.env.DESKTOP_MODE !== '1') return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  if (!isLocalOrigin(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  res.setHeader('Cache-Control', 'no-store');
  try {
    // 与真实分析链路共用同一套 key 解析，避免新增来源后这里漏判导致只抓取不分析。
    const { apiKey } = await getEffectiveLlmConfig();
    res.status(200).json({ llmConfigured: Boolean(apiKey) });
  } catch (error) {
    console.error('[api/desktop/runtime] Error:', error);
    res.status(500).json({ error: '读取运行状态失败' });
  }
}
