import path from 'path'
import os from 'os'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  createAgentSession,
  agentSessionExists,
  deleteAgentSession,
  appendAgentMessage,
  getAgentMessages,
  compactAgentMessages,
  getDb,
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
})

describe('compactAgentMessages 上下文压缩原子性', () => {
  beforeAll(async () => {
    await getDb() // 触发建表
  })

  it('追加摘要并删除被压缩的旧消息,保留 id 更大的最近消息', async () => {
    const sid = await createAgentSession('compact-test')
    try {
      const id1 = await appendAgentMessage(sid, 'user', 'msg-1')
      const id2 = await appendAgentMessage(sid, 'assistant', 'msg-2')
      const id3 = await appendAgentMessage(sid, 'user', 'msg-3')
      const id4 = await appendAgentMessage(sid, 'assistant', 'msg-4')

      // 压缩掉 id <= id3 的旧消息
      const summaryId = await compactAgentMessages(sid, id3, '（历史对话已压缩）summary')

      const rows = await getAgentMessages(sid) // ORDER BY id ASC
      expect(rows.map((r) => r.id)).toEqual([id4, summaryId])
      expect(rows[1].content).toBe('（历史对话已压缩）summary')
      // 摘要消息 id 大于被删的旧消息
      expect(summaryId).toBeGreaterThan(id3)
      // 保留消息原样保留
      expect(rows[0].content).toBe('msg-4')
      expect(rows[0].id).toBe(id4)
    } finally {
      await deleteAgentSession(sid)
    }
  })

  it('压缩幂等:再次压缩同一 upToMessageId 不报错(旧消息已删,无副作用)', async () => {
    const sid = await createAgentSession('compact-idempotent')
    try {
      const id1 = await appendAgentMessage(sid, 'user', 'a')
      const id2 = await appendAgentMessage(sid, 'user', 'b')
      await compactAgentMessages(sid, id1, 's1')
      // 再次压缩到已删除的 id1:事务成功,仅追加新摘要(不误删 s1/id2)
      await compactAgentMessages(sid, id1, 's2')
      const rows = await getAgentMessages(sid)
      expect(rows).toHaveLength(3) // id2 + s1 + s2
      expect(rows.map((r) => r.content)).toEqual(['b', 's1', 's2'])
    } finally {
      await deleteAgentSession(sid)
    }
  })
})
