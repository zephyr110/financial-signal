import { createAgentShare, getSharedSession, revokeAgentShare } from '../../lib/db';
import { isLocalOrigin } from '../../lib/cronAuth';

/**
 * 会话分享链接：
 * - POST { sessionId } → 创建/复用未过期的 token，返回 { token, path, expiresAt }
 * - DELETE ?sessionId= → 撤销该会话的全部有效链接
 * - GET ?token= → 只读返回 { title, messages, expiresAt }（公开访问，token 即凭据）
 *
 * 写操作在桌面模式（proxy 放行全部）下校验本机 Origin，防跨站创建/撤销分享。
 */
export default async function handler(req: any, res: any) {
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (process.env.DESKTOP_MODE === '1' && !isLocalOrigin(req.headers.origin, req.headers.host)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
  }

  if (req.method === 'POST') {
    const sessionId = Number(req.body?.sessionId);
    if (!Number.isFinite(sessionId) || sessionId < 1) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    try {
      const share = await createAgentShare(sessionId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ...share, path: `/agent/s/${share.token}` });
    } catch (error) {
      console.error('[api/agent-share] Error:', error);
      res.status(500).json({ error: 'Failed to create share link' });
    }
    return;
  }

  if (req.method === 'DELETE') {
    const sessionId = Number(req.query.sessionId);
    if (!Number.isFinite(sessionId) || sessionId < 1) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    try {
      const revoked = await revokeAgentShare(sessionId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ ok: true, revoked });
    } catch (error) {
      console.error('[api/agent-share] revoke error:', error);
      res.status(500).json({ error: 'Failed to revoke share link' });
    }
    return;
  }

  if (req.method === 'GET') {
    const token = String(req.query.token || '');
    if (!token) {
      return res.status(400).json({ error: 'Missing token' });
    }
    try {
      const data = await getSharedSession(token);
      if (!data) {
        return res.status(404).json({ error: 'Share link not found' });
      }
      // 分享后追加消息即时可见：不缓存
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(data);
    } catch (error) {
      console.error('[api/agent-share] Error:', error);
      res.status(500).json({ error: 'Failed to load shared session' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}
