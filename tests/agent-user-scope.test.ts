import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'

/**
 * P13：Agent 数据按账号作用域。
 * 新行写 user_id；历史行 user_id IS NULL 视为 legacy 全局可见；
 * 不匹配的账号按“不存在”处理（null / false / 404），不暴露归属。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-user-scope-test-'))
let db: typeof import('../lib/db')
let memory: typeof import('../lib/agent/memory')
let projects: typeof import('../lib/agent/projects')
let actions: typeof import('../lib/agent/actions')

describe('agent data scoped by account', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'scope.db')
    vi.resetModules()
    db = await import('../lib/db')
    memory = await import('../lib/agent/memory')
    projects = await import('../lib/agent/projects')
    actions = await import('../lib/agent/actions')
    await db.getDb()
  })

  it('会话列表与存在性按账号隔离，legacy(NULL) 对双方可见', async () => {
    const s1 = await db.createAgentSession('u1-session', 1)
    const s2 = await db.createAgentSession('only-user-two-keyword', 2)
    const legacy = await db.createAgentSession('legacy-session')

    expect(await db.agentSessionExists(s1, 1)).toBe(true)
    expect(await db.agentSessionExists(s1, 2)).toBe(false)
    expect(await db.agentSessionExists(legacy, 2)).toBe(true)

    const page1 = await db.listAgentSessionsPage({ userId: 1, limit: 50 })
    const ids1 = page1.sessions.map((r) => Number(r.id))
    expect(ids1).toContain(s1)
    expect(ids1).toContain(legacy)
    expect(ids1).not.toContain(s2)

    const page2 = await db.listAgentSessionsPage({ userId: 2, limit: 50 })
    const ids2 = page2.sessions.map((r) => Number(r.id))
    expect(ids2).toContain(s2)
    expect(ids2).toContain(legacy)
    expect(ids2).not.toContain(s1)

    // 搜索同样受账号约束：别人标题命中的会话不能出现在自己的搜索结果里
    const search1 = await db.listAgentSessionsPage({ userId: 1, query: 'only-user-two-keyword' })
    expect(search1.sessions.map((r) => Number(r.id))).not.toContain(s2)
    const search2 = await db.listAgentSessionsPage({ userId: 2, query: 'only-user-two-keyword' })
    expect(search2.sessions.map((r) => Number(r.id))).toContain(s2)
  })

  it('同一 key 在不同账号下各存一条，互不可见、互不可删', async () => {
    const m1 = await memory.upsertAgentMemory({ scope: 'user', key: '关注主题', value: '半导体', userId: 1 })
    const m2 = await memory.upsertAgentMemory({ scope: 'user', key: '关注主题', value: '消费', userId: 2 })
    const legacy = await memory.upsertAgentMemory({ scope: 'user', key: 'legacy-偏好', value: '保留' })

    expect(m1.id).not.toBe(m2.id)
    // 展示时剥掉存储键前缀
    expect(m1.key).toBe('关注主题')
    expect(m2.key).toBe('关注主题')

    const list1 = await memory.listAgentMemories({ userId: 1, limit: 100 })
    const ids1 = list1.map((m) => m.id)
    expect(ids1).toContain(m1.id)
    expect(ids1).toContain(legacy.id)
    expect(ids1).not.toContain(m2.id)

    const list2 = await memory.listAgentMemories({ userId: 2, limit: 100 })
    expect(list2.map((m) => m.id)).toContain(m2.id)
    expect(list2.map((m) => m.id)).not.toContain(m1.id)

    expect(await memory.deleteAgentMemory(m2.id, 1)).toBe(false)
    expect(await memory.deleteAgentMemory(m2.id, 2)).toBe(true)
  })

  it('研究项目跨账号不可见、不可写', async () => {
    const p1 = await projects.createProject({ name: '账号一项目', userId: 1 })

    expect(await projects.getProject(p1.id, 1)).not.toBeNull()
    expect(await projects.getProject(p1.id, 2)).toBeNull()

    const list2 = await projects.listProjects({ userId: 2, status: 'all' })
    expect(list2.map((p) => p.id)).not.toContain(p1.id)

    expect(await projects.addProjectItem({ projectId: p1.id, kind: 'note', refId: 'r1', userId: 2 })).toBeNull()
    expect(await projects.updateProject(p1.id, { name: '改名' }, 2)).toBeNull()
    expect(await projects.removeProjectItem(p1.id, 'note', 'r1', 2)).toBe(false)

    const item = await projects.addProjectItem({ projectId: p1.id, kind: 'note', refId: 'r1', userId: 1 })
    expect(item).not.toBeNull()
  })

  it('动作提案归属发起账号，跨账号解析返回 null', async () => {
    const payload = { scope: 'user', key: '动作记忆', value: 'v1' }
    const a1 = await actions.proposeAgentAction({ type: 'save_memory', payload, userId: 1 })
    const a1Again = await actions.proposeAgentAction({ type: 'save_memory', payload, userId: 1 })
    const a2 = await actions.proposeAgentAction({ type: 'save_memory', payload, userId: 2 })

    // 去重只在同一账号内生效
    expect(a1Again.id).toBe(a1.id)
    expect(a2.id).not.toBe(a1.id)
    expect(a1.userId).toBe(1)

    expect(await actions.getAgentAction(a1.id, 2)).toBeNull()
    expect((await actions.listAgentActions({ userId: 2, limit: 100 })).map((a) => a.id)).not.toContain(a1.id)
    expect(await actions.resolveAgentAction(a1.id, 'confirm', 2)).toBeNull()

    // 确认后的记忆写回提案所属账号
    const resolved = await actions.resolveAgentAction(a1.id, 'confirm', 1)
    expect(resolved?.status).toBe('confirmed')
    const list1 = await memory.listAgentMemories({ userId: 1, limit: 100 })
    const list2 = await memory.listAgentMemories({ userId: 2, limit: 100 })
    expect(list1.map((m) => m.value)).toContain('v1')
    expect(list2.map((m) => m.value)).not.toContain('v1')
  })
})
