import path from 'path'
import os from 'os'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  createAgentSession,
  agentSessionExists,
  deleteAgentSession,
  renameAgentSession,
  appendAgentMessage,
  getAgentMessages,
  compactAgentMessages,
  getDb,
  listAgentSessions,
} from '../lib/db'

// 隔离 DB：本测试会建表/插入/删除，不能落在共享的项目 DB
process.env.NEWS_DB_PATH = path.join(os.tmpdir(), `test-agentsession-${process.pid}.db`)

/**
 * 悬空 sessionId 防御（生产事故回归保护）：
 * 浏览器 localStorage 可能缓存已删除的会话 → 向不存在的会话插入消息会触发
 * SQLITE_CONSTRAINT 外键错误 → agent 500「研究助手暂时不可用」。
 * 这里验证 exists 探测 + 删除后引用失效，确保回退逻辑可依赖。
 */
describe('agent session existence guard', () => {
  beforeAll(async () => {
    await getDb() // 触发建表
  })

  it('reports false for nonexistent session', async () => {
    expect(await agentSessionExists(999999)).toBe(false)
  })

  it('reports true after creation, false after deletion', async () => {
    const sid = await createAgentSession('guard-test')
    expect(await agentSessionExists(sid)).toBe(true)
    await deleteAgentSession(sid)
    expect(await agentSessionExists(sid)).toBe(false)
  })

  it('foreign key constraint rejects message insertion into deleted session', async () => {
    const sid = await createAgentSession('fk-test')
    await deleteAgentSession(sid)
    await expect(appendAgentMessage(sid, 'user', 'hello')).rejects.toThrow(/FOREIGN KEY|SQLITE_CONSTRAINT/i)
  })

  it('renameAgentSession 仅改标题,不更新 updated_at', async () => {
    const sid = await createAgentSession('old-title')
    const before = await listAgentSessions(10)
    const row = before.find((r) => Number(r.id) === sid) as Record<string, unknown>
    expect(row?.title).toBe('old-title')
    const updatedAt = String(row?.updated_at)

    expect(await renameAgentSession(sid, '  new title  ')).toBe(true)
    const after = await listAgentSessions(10)
    const renamed = after.find((r) => Number(r.id) === sid) as Record<string, unknown>
    expect(renamed?.title).toBe('new title')
    expect(String(renamed?.updated_at)).toBe(updatedAt)

    expect(await renameAgentSession(sid, '   ')).toBe(false)
    expect(await renameAgentSession(999999, 'x')).toBe(false)

    await deleteAgentSession(sid)
  })
})

describe('compactAgentMessages 上下文压缩原子性', () => {
  beforeAll(async () => {
    await getDb() // 触发建表
  })

  it('摘要成为新根,被压缩的旧消息保留为不可见分支', async () => {
    const sid = await createAgentSession('compact-test')
    try {
      await appendAgentMessage(sid, 'user', 'msg-1')
      await appendAgentMessage(sid, 'assistant', 'msg-2')
      await appendAgentMessage(sid, 'user', 'msg-3')
      const id4 = await appendAgentMessage(sid, 'assistant', 'msg-4')

      // 只保留最后一条 msg-4,更早的消息折进摘要
      const summaryId = await compactAgentMessages(sid, id4, '（历史对话已压缩）summary')

      const rows = await getAgentMessages(sid) // 可见路径:摘要 → msg-4
      expect(rows.map((r) => r.content)).toEqual(['（历史对话已压缩）summary', 'msg-4'])
      expect(rows[0].role).toBe('system')
      expect(rows[1].id).toBe(id4)
      expect(summaryId).toBeGreaterThan(id4)
      // 旧消息仍在库中,只是不在可见分支上
      const db = await getDb()
      const raw = await db.execute({
        sql: 'SELECT COUNT(*) AS n FROM agent_message WHERE session_id = ?',
        args: [sid],
      })
      expect(Number(raw.rows[0].n)).toBe(5)
    } finally {
      await deleteAgentSession(sid)
    }
  })

  it('重复压缩:新摘要取代旧摘要成为根,历史仍可追溯', async () => {
    const sid = await createAgentSession('compact-idempotent')
    try {
      const id1 = await appendAgentMessage(sid, 'user', 'a')
      await appendAgentMessage(sid, 'user', 'b')
      await compactAgentMessages(sid, id1, 's1')
      expect((await getAgentMessages(sid)).map((r) => r.content)).toEqual(['s1', 'a', 'b'])

      await compactAgentMessages(sid, id1, 's2')
      const rows = await getAgentMessages(sid)
      expect(rows.map((r) => r.content)).toEqual(['s2', 'a', 'b'])
    } finally {
      await deleteAgentSession(sid)
    }
  })
})
