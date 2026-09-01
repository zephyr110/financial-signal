import { listAgentSessions, getAgentMessages, deleteAgentSession, agentSessionExists } from '../../lib/db';
import { isLocalOrigin } from '../../lib/cronAuth';

/**
 * 研究 Agent — 会话历史 API
 *
 * GET /api/agent-sessions          → 会话列表 [{ id, title, created_at, updated_at }]
 * GET /api/agent-sessions?id=N     → 会话全部消息 [{ id, role, content, meta, created_at }]
 * DELETE /api/agent-sessions?id=N  → 删除会话及其消息
 *
 * 桌面模式（proxy 放行全部）下 DELETE 为破坏性操作,校验本机 Origin 防跨站删除。
 */
export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    if (process.env.DESKTOP_MODE === '1' && !isLocalOrigin(req.headers.origin, req.headers.host)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
    const { id } = req.query;
    if (id == null) return res.status(400).json({ error: '缺少 sessionId' });
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid <= 0) {
      return res.status(400).json({ error: 'sessionId 非法' });
    }
    try {
      await deleteAgentSession(sid);
      return res.status(200).json({ ok: true, sessionId: sid });
    } catch (error) {
      console.error('[api/agent-sessions] DELETE error:', error);
      return res.status(500).json({ error: '会话删除失败，请稍后重试' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET', 'DELETE']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;

  // 非法 sessionId（NaN/0/负数）直接 400，避免把坏值传给 DB
  if (id != null) {
    const sid = Number(id);
    if (!Number.isFinite(sid) || sid <= 0) {
      return res.status(400).json({ error: 'sessionId 非法' });
    }
    try {
      // 会话不存在返回 404：前端据此清理 localStorage 里残留的失效 sessionId
      const exists = await agentSessionExists(sid);
      if (!exists) return res.status(404).json({ error: '会话不存在', sessionId: sid });
      const messages = await getAgentMessages(sid);
      return res.status(200).json({ sessionId: sid, messages });
    } catch (error) {
      console.error('[api/agent-sessions] GET detail error:', error);
      return res.status(500).json({ error: '会话加载失败，请稍后重试' });
    }
  }

  try {
    const sessions = await listAgentSessions(50);
    return res.status(200).json({ sessions });
  } catch (error) {
    console.error('[api/agent-sessions] GET list error:', error);
    return res.status(500).json({ error: '会话列表加载失败，请稍后重试' });
  }
}
