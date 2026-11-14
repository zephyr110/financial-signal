import {
  listAgentSessionsPage,
  getAgentMessages,
  deleteAgentSession,
  renameAgentSession,
  agentSessionExists,
  listAgentTurns,
} from '../../lib/db';
import { isLocalOrigin } from '../../lib/cronAuth';

const SESSION_TITLE_MAX = 120;

function assertDesktopMutationOrigin(req, res): boolean {
  if (process.env.DESKTOP_MODE === '1' && !isLocalOrigin(req.headers.origin, req.headers.host)) {
    res.status(403).json({ error: 'Forbidden origin' });
    return false;
  }
  return true;
}

function parseSessionId(id: unknown): number | null {
  if (id == null) return null;
  const sid = Number(id);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  return sid;
}

/**
 * 研究 Agent — 会话历史 API
 *
 * GET /api/agent-sessions?q=&limit=&offset= → 会话分页搜索 { sessions, total }
 * GET /api/agent-sessions?id=N     → 会话全部消息 [{ id, role, content, meta, created_at }] + turns（反馈/成本）
 * PATCH /api/agent-sessions?id=N   → 重命名 { title }
 * DELETE /api/agent-sessions?id=N  → 删除会话及其消息
 *
 * 桌面模式下 DELETE/PATCH 为写操作,校验本机 Origin 防跨站。
 */
export default async function handler(req, res) {
  if (req.method === 'PATCH') {
    if (!assertDesktopMutationOrigin(req, res)) return;
    const sid = parseSessionId(req.query.id);
    if (sid == null) return res.status(400).json({ error: 'sessionId 非法' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ error: '标题不能为空' });
    if (title.length > SESSION_TITLE_MAX) {
      return res.status(400).json({ error: `标题不能超过 ${SESSION_TITLE_MAX} 个字符` });
    }
    try {
      const exists = await agentSessionExists(sid);
      if (!exists) return res.status(404).json({ error: '会话不存在', sessionId: sid });
      const ok = await renameAgentSession(sid, title);
      if (!ok) return res.status(400).json({ error: '标题无效' });
      return res.status(200).json({ ok: true, sessionId: sid, title });
    } catch (error) {
      console.error('[api/agent-sessions] PATCH error:', error);
      return res.status(500).json({ error: '会话重命名失败，请稍后重试' });
    }
  }

  if (req.method === 'DELETE') {
    if (!assertDesktopMutationOrigin(req, res)) return;
    const { id } = req.query;
    if (id == null) return res.status(400).json({ error: '缺少 sessionId' });
    const sid = parseSessionId(id);
    if (sid == null) return res.status(400).json({ error: 'sessionId 非法' });
    try {
      await deleteAgentSession(sid);
      return res.status(200).json({ ok: true, sessionId: sid });
    } catch (error) {
      console.error('[api/agent-sessions] DELETE error:', error);
      return res.status(500).json({ error: '会话删除失败，请稍后重试' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET', 'PATCH', 'DELETE']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const { id } = req.query;

  // 非法 sessionId（NaN/0/负数）直接 400，避免把坏值传给 DB
  if (id != null) {
    const sid = parseSessionId(id);
    if (sid == null) return res.status(400).json({ error: 'sessionId 非法' });
    try {
      // 会话不存在返回 404：前端据此清理 localStorage 里残留的失效 sessionId
      const exists = await agentSessionExists(sid);
      if (!exists) return res.status(404).json({ error: '会话不存在', sessionId: sid });
      const [messages, turns] = await Promise.all([getAgentMessages(sid), listAgentTurns(sid, 50)]);
      return res.status(200).json({ sessionId: sid, messages, turns });
    } catch (error) {
      console.error('[api/agent-sessions] GET detail error:', error);
      return res.status(500).json({ error: '会话加载失败，请稍后重试' });
    }
  }

  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const page = await listAgentSessionsPage({ limit, offset, query: q });
    return res.status(200).json({ ...page, limit, offset, q });
  } catch (error) {
    console.error('[api/agent-sessions] GET list error:', error);
    return res.status(500).json({ error: '会话列表加载失败，请稍后重试' });
  }
}
