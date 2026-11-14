import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * P11：回合遥测、反馈、会话分页搜索、分享过期/撤销。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-telemetry-test-'))
let db: typeof import('../lib/db')

describe('agent engineering', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'agent.db')
    vi.resetModules()
    db = await import('../lib/db')
    await db.getDb()
  })

  it('回合遥测可记录 token、成本、步数并接受反馈', async () => {
    const sid = await db.createAgentSession('遥测会话')
    const turnId = await db.startAgentTurn(sid, 'deepseek-test')
    await db.recordAgentTurnUsage({
      turnId,
      model: 'deepseek-test',
      promptTokens: 100,
      completionTokens: 40,
      costMicros: 180,
      latencyMs: 120,
    })
    await db.finishAgentTurn(turnId, {
      status: 'succeeded',
      model: 'deepseek-test',
      promptTokens: 100,
      completionTokens: 40,
      cachedTokens: 20,
      costMicros: 180,
      contextTokens: 300,
      compacted: true,
      toolCalls: 2,
      steps: 3,
    })

    let turns = await db.listAgentTurns(sid)
    expect(turns[0]).toMatchObject({
      id: turnId,
      status: 'succeeded',
      promptTokens: 100,
      completionTokens: 40,
      cachedTokens: 20,
      costMicros: 180,
      contextTokens: 300,
      compacted: true,
      toolCalls: 2,
      steps: 3,
    })

    expect(await db.setAgentTurnFeedback(turnId, 'up')).toBe(true)
    turns = await db.listAgentTurns(sid)
    expect(turns[0].feedback).toBe('up')
    await db.deleteAgentSession(sid)
  })

  it('会话搜索覆盖标题与消息正文，并支持分页', async () => {
    const a = await db.createAgentSession('存储研究')
    const b = await db.createAgentSession('无关标题')
    await db.appendAgentMessage(b, 'user', '问一下稀土出口管制的进展')
    const c = await db.createAgentSession('第三会话')

    const byTitle = await db.listAgentSessionsPage({ query: '存储' })
    expect(byTitle.sessions.map((s) => Number(s.id))).toContain(a)

    const byMessage = await db.listAgentSessionsPage({ query: '稀土' })
    expect(byMessage.sessions.map((s) => Number(s.id))).toContain(b)
    expect(byMessage.sessions.map((s) => Number(s.id))).not.toContain(c)

    const page1 = await db.listAgentSessionsPage({ limit: 1, offset: 0 })
    const page2 = await db.listAgentSessionsPage({ limit: 1, offset: 1 })
    expect(page1.total).toBeGreaterThanOrEqual(3)
    expect(Number(page1.sessions[0].id)).not.toBe(Number(page2.sessions[0].id))
  })

  it('分享链接过期失效，撤销后重新分享得到新 token', async () => {
    const sid = await db.createAgentSession('分享生命周期')
    const first = await db.createAgentShare(sid)
    expect(first.expiresAt).toBeTruthy()

    await db.getDb().then((handle) =>
      handle.execute({ sql: "UPDATE agent_share SET expires_at = datetime('now', '-1 minute') WHERE token = ?", args: [first.token] }),
    )
    expect(await db.getSharedSession(first.token)).toBeNull()

    const second = await db.createAgentShare(sid)
    expect(second.token).not.toBe(first.token)
    expect(await db.getSharedSession(second.token)).not.toBeNull()

    expect(await db.revokeAgentShare(sid)).toBeGreaterThan(0)
    expect(await db.getSharedSession(second.token)).toBeNull()
  })

  afterAll(async () => {
    const handle = await db.getDb()
    await handle.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
