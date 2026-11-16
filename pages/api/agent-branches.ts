import { agentSessionExists, selectAgentMessageVersion } from '../../lib/db';
import { isLocalOrigin } from '../../lib/cronAuth';
import { requestUserId } from '../../lib/request-user';

/**
 * POST /api/agent-branches — 切换消息版本
 * body: { sessionId, messageId }
 * 只改树的 selected_child_id/root，不复制消息；前端随后重载会话。
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  if (process.env.DESKTOP_MODE === '1' && !isLocalOrigin(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }

  const sessionId = Number(req.body?.sessionId);
  const messageId = Number(req.body?.messageId);
  if (!Number.isInteger(sessionId) || sessionId <= 0 || !Number.isInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ error: 'sessionId 或 messageId 非法' });
  }

  try {
    const userId = await requestUserId(req);
    if (!(await agentSessionExists(sessionId, userId))) {
      return res.status(404).json({ error: '会话不存在', sessionId });
    }
    const ok = await selectAgentMessageVersion(sessionId, messageId);
    if (!ok) return res.status(404).json({ error: '消息不存在或不可切换', sessionId });
    return res.status(200).json({ ok: true, sessionId, messageId });
  } catch (error) {
    console.error('[api/agent-branches] POST error:', error);
    return res.status(500).json({ error: '切换消息版本失败，请稍后重试' });
  }
}
