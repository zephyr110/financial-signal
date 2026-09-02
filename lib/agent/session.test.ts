import path from 'path'
import os from 'os'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import {
  createAgentSession,
  deleteAgentSession,
  appendAgentMessage,
  getDb,
} from '../db'

process.env.NEWS_DB_PATH = path.join(os.tmpdir(), `test-session-${process.pid}.db`)

const chatCompletion = vi.fn().mockResolvedValue({ content: '用户关注半导体，助手给出行业热力分析。' })

vi.mock('../llm/client', () => ({ chatCompletion }))
vi.mock('../llm/config', () => ({ LLM_CONFIG: { apiKey: 'test' } }))

const { loadAgentContext, CONTEXT_BUDGET_TOKENS } = await import('./session')

describe('loadAgentContext 压缩回调', () => {
  beforeAll(async () => {
    await getDb()
  })

  it('超预算时触发 onCompact 并继续返回压缩后上下文', async () => {
    const sid = await createAgentSession('compact-cb')
    try {
      // 造足够长的历史以超预算
      const chunk = 'x'.repeat(Math.ceil(CONTEXT_BUDGET_TOKENS * 1.5))
      for (let i = 0; i < 12; i++) {
        await appendAgentMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `${chunk}-${i}`)
      }

      const events: string[] = []
      let summarized = 0
      const history = await loadAgentContext(sid, {
        onCompact: (e) => {
          events.push(e.type)
          if (e.type === 'end') summarized = e.messageCount
        },
      })

      expect(events).toEqual(['start', 'end'])
      expect(summarized).toBeGreaterThan(0)
      expect(history[0].role).toBe('system')
      expect(history[0].content).toContain('（历史对话已压缩）')
      expect(history.length).toBeLessThan(13)
    } finally {
      await deleteAgentSession(sid)
    }
  })

  it('落库后重载时压缩摘要排在保留消息之前', async () => {
    const sid = await createAgentSession('compact-order')
    try {
      const id1 = await appendAgentMessage(sid, 'user', 'old-1')
      const id2 = await appendAgentMessage(sid, 'assistant', 'old-2')
      const id3 = await appendAgentMessage(sid, 'user', 'recent-user')
      await appendAgentMessage(sid, 'assistant', 'recent-assistant')
      const { compactAgentMessages } = await import('../db')
      await compactAgentMessages(sid, id2, '（历史对话已压缩）摘要内容', {
        contextCompact: true,
        summarizedCount: 2,
      })

      const history = await loadAgentContext(sid)
      expect(history[0].content).toContain('（历史对话已压缩）')
      expect(history[1].content).toBe('recent-user')
      expect(history.map((m) => m.id)).toEqual(
        expect.arrayContaining([expect.any(Number)]),
      )
      expect(history.length).toBe(3)
      void id1
      void id3
    } finally {
      await deleteAgentSession(sid)
    }
  })

  it('压缩失败时回调 failed 并保留完整历史', async () => {
    chatCompletion.mockRejectedValueOnce(new Error('LLM down'))
    const sid = await createAgentSession('compact-fail')
    try {
      const chunk = 'x'.repeat(Math.ceil(CONTEXT_BUDGET_TOKENS * 1.5))
      for (let i = 0; i < 12; i++) {
        await appendAgentMessage(sid, i % 2 === 0 ? 'user' : 'assistant', `${chunk}-${i}`)
      }

      const events: Array<{ type: string; failed?: boolean }> = []
      const history = await loadAgentContext(sid, {
        onCompact: (e) => events.push(e),
      })

      expect(events.map((e) => e.type)).toEqual(['start', 'end'])
      expect(events[1]?.failed).toBe(true)
      expect(history.length).toBe(12)
    } finally {
      await deleteAgentSession(sid)
    }
  })
})
