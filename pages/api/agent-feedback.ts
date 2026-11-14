import { setAgentTurnFeedback } from '../../lib/db';
import { isLocalOrigin } from '../../lib/cronAuth';

/**
 * 单轮回答反馈：POST { turnId, feedback: 'up'|'down'|null, note? }
 * 只写 agent_turn 的反馈字段，不改会话内容。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (process.env.DESKTOP_MODE === '1' && !isLocalOrigin(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Forbidden origin' });
  }
  const turnId = typeof req.body?.turnId === 'string' ? req.body.turnId.trim() : '';
  const feedback = req.body?.feedback;
  if (!turnId) return res.status(400).json({ error: 'turnId 必填' });
  if (feedback !== null && feedback !== 'up' && feedback !== 'down') {
    return res.status(400).json({ error: 'feedback 只能为 up/down/null' });
  }
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
  try {
    const ok = await setAgentTurnFeedback(turnId, feedback, note);
    if (!ok) return res.status(404).json({ error: '回合不存在' });
    return res.status(200).json({ ok: true, turnId, feedback });
  } catch (error) {
    console.error('[api/agent-feedback] error:', error);
    return res.status(500).json({ error: '反馈保存失败' });
  }
}
