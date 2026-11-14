import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * P12：长期记忆、研究项目与“先提案、后确认”的安全动作。
 */

const tasksMock = vi.hoisted(() => ({
  enqueueTask: vi.fn(async () => ({ id: 'task-1', status: 'queued', type: 'desk_tick' })),
  scheduleTaskDrain: vi.fn(),
}))
const notifyMock = vi.hoisted(() => ({
  createNotification: vi.fn(async () => ({ id: 'notice-1' })),
}))

vi.mock('../lib/cockpit/tasks', () => tasksMock)
vi.mock('../lib/cockpit/notifications', () => notifyMock)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-projects-test-'))
let dbModule: typeof import('../lib/db')
let memory: typeof import('../lib/agent/memory')
let projects: typeof import('../lib/agent/projects')
let actions: typeof import('../lib/agent/actions')
let tools: typeof import('../lib/agent/tools')

describe('agent memory & projects & safe actions', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'agent-memory.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    memory = await import('../lib/agent/memory')
    projects = await import('../lib/agent/projects')
    actions = await import('../lib/agent/actions')
    tools = await import('../lib/agent/tools')
    await dbModule.getDb()
  })

  it('记忆去重更新、项目命名空间与到期降级', async () => {
    const first = await memory.upsertAgentMemory({
      scope: 'user',
      key: '关注偏好',
      value: '偏好半导体与设备',
      confidence: 0.7,
    })
    expect(first.status).toBe('active')
    expect(first.confidence).toBe(0.7)

    const updated = await memory.upsertAgentMemory({
      scope: 'user',
      key: '关注偏好',
      value: '偏好半导体、设备与材料',
      confidence: 0.8,
    })
    expect(updated.id).toBe(first.id)
    expect(updated.value).toContain('材料')

    const p1 = await memory.upsertAgentMemory({ scope: 'project', projectId: 'p1', key: 'focus', value: '设备国产化' })
    const p2 = await memory.upsertAgentMemory({ scope: 'project', projectId: 'p2', key: 'focus', value: '存储周期' })
    expect(p1.id).not.toBe(p2.id)
    expect(p1.key).toBe('project:p1:focus')
    expect(p2.key).toBe('project:p2:focus')

    const expired = await memory.upsertAgentMemory({
      scope: 'industry',
      key: '临时观点',
      value: '仅当天有效',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(await memory.decayExpiredMemories()).toBeGreaterThanOrEqual(1)
    const active = await memory.listAgentMemories({ limit: 50 })
    expect(active.some((item) => item.id === expired.id)).toBe(false)

    const prompt = await memory.loadAgentMemoryPrompt()
    expect(prompt).toContain('关注偏好')
    expect(prompt).toContain('project:p1:focus')
    expect(prompt).not.toContain('仅当天有效')

    expect(await memory.deleteAgentMemory(updated.id)).toBe(true)
    const afterDelete = await memory.loadAgentMemoryPrompt()
    expect(afterDelete).not.toContain('关注偏好')
  })

  it('研究项目可建、可更新、可挂条目并生成上下文', async () => {
    const project = await projects.createProject({
      name: '半导体设备国产化',
      thesis: '验证设备招标与国产替代节奏',
      industries: ['半导体', ' 机械设备 ', ''],
      symbols: ['688041'],
    })
    expect(project.name).toContain('半导体')
    expect(project.industries).toEqual(['半导体', '机械设备'])

    const item = await projects.addProjectItem({
      projectId: project.id,
      kind: 'symbol',
      refId: '688041',
      title: '海光信息',
      note: '观察招标节奏',
    })
    expect(item?.refId).toBe('688041')

    const reloaded = await projects.getProject(project.id)
    expect(reloaded?.items).toHaveLength(1)
    const context = await projects.projectContext(project.id)
    expect(context).toContain('半导体设备国产化')
    expect(context).toContain('688041')

    const updated = await projects.updateProject(project.id, { status: 'archived' })
    expect(updated?.status).toBe('archived')
    expect(await projects.removeProjectItem(project.id, 'symbol', '688041')).toBe(true)
    expect(await projects.addProjectItem({ projectId: 'missing', kind: 'note', refId: 'x' })).toBeNull()
  })

  it('动作提案不执行，确认后才落库', async () => {
    const proposed = await actions.proposeAgentAction({
      type: 'save_memory',
      payload: { scope: 'user', key: '风险偏好', value: '低回撤优先' },
      sessionId: '7',
      turnId: 'turn-7',
    })
    expect(proposed.status).toBe('proposed')
    const before = await memory.listAgentMemories({ limit: 50 })
    expect(before.some((item) => item.key === '风险偏好')).toBe(false)

    const done = await actions.resolveAgentAction(proposed.id, 'confirm')
    expect(done?.status).toBe('confirmed')
    expect(done?.result?.memoryId).toBeTruthy()
    const after = await memory.listAgentMemories({ limit: 50 })
    expect(after.some((item) => item.key === '风险偏好')).toBe(true)

    const again = await actions.resolveAgentAction(proposed.id, 'confirm')
    expect(again?.status).toBe('confirmed')
    expect(tasksMock.enqueueTask).not.toHaveBeenCalled()
  })

  it('过期提案不会被再次复用', async () => {
    const first = await actions.proposeAgentAction({
      type: 'watch_event',
      payload: { title: '过期事项', code: '600000' },
    })
    const db = await dbModule.getDb()
    await db.execute({
      sql: "UPDATE agent_action SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
      args: [first.id],
    })
    const second = await actions.proposeAgentAction({
      type: 'watch_event',
      payload: { title: '过期事项', code: '600000' },
    })
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('proposed')
  })

  it('拒绝后不产生副作用，非法任务被白名单拦截', async () => {
    const proposed = await actions.proposeAgentAction({
      type: 'create_task',
      payload: { type: 'desk_tick', params: { tradeDate: '2026-11-14' } },
    })
    const rejected = await actions.resolveAgentAction(proposed.id, 'reject')
    expect(rejected?.status).toBe('rejected')
    expect(tasksMock.enqueueTask).not.toHaveBeenCalled()

    expect(() => actions.validateActionPayload('create_task', { type: 'rm -rf /' })).toThrow('白名单')
    expect(() => actions.validateActionPayload('pin_project', { projectId: 'p1', kind: 'note' })).toThrow('refId')
  })

  it('确认任务调度、关注通知与项目条目动作', async () => {
    const taskAction = await actions.proposeAgentAction({
      type: 'create_task',
      payload: { type: 'desk_tick', params: { tradeDate: '2026-11-14', force: true, lane: 'core' } },
    })
    const taskDone = await actions.resolveAgentAction(taskAction.id, 'confirm')
    expect(taskDone?.status).toBe('confirmed')
    expect(tasksMock.enqueueTask).toHaveBeenCalledWith({
      type: 'desk_tick',
      params: { tradeDate: '2026-11-14', force: true },
    })
    expect(tasksMock.scheduleTaskDrain).toHaveBeenCalled()

    const watch = await actions.proposeAgentAction({
      type: 'watch_event',
      payload: { title: '关注存储涨价', note: '验证渠道库存', code: '688041' },
    })
    const watchDone = await actions.resolveAgentAction(watch.id, 'confirm')
    expect(watchDone?.status).toBe('confirmed')
    expect(notifyMock.createNotification).toHaveBeenCalled()

    const watchDb = await dbModule.getDb()
    const noteOf = async () => String((await watchDb.execute({
      sql: 'SELECT note FROM watchlist_items WHERE code = ?',
      args: ['688041'],
    })).rows[0]?.note)
    expect(await noteOf()).toBe('验证渠道库存')
    // 后一次关注不带备注，不能把用户已写的备注盖成兜底文案
    const again = await actions.proposeAgentAction({ type: 'watch_event', payload: { title: '重复关注', code: '688041' } })
    await actions.resolveAgentAction(again.id, 'confirm')
    expect(await noteOf()).toBe('验证渠道库存')
    expect((await watchDb.execute({
      sql: 'SELECT COUNT(*) AS n FROM watchlist_items WHERE code = ?',
      args: ['688041'],
    })).rows[0]?.n).toBe(1)

    const project = await projects.createProject({ name: '项目挂载', symbols: [] })
    const pin = await actions.proposeAgentAction({
      type: 'pin_project',
      payload: { projectId: project.id, kind: 'note', refId: 'note-1', title: '渠道库存', note: '待核' },
    })
    expect((await actions.resolveAgentAction(pin.id, 'confirm'))?.status).toBe('confirmed')
    expect((await projects.getProject(project.id))?.items).toHaveLength(1)
  })

  it('过期提案不能执行；工具只提交待确认动作', async () => {
    const proposed = await actions.proposeAgentAction({
      type: 'save_memory',
      payload: { scope: 'user', key: '过期偏好', value: '不该写入' },
    })
    const db = await dbModule.getDb()
    await db.execute({
      sql: "UPDATE agent_action SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
      args: [proposed.id],
    })
    const expired = await actions.resolveAgentAction(proposed.id, 'confirm')
    expect(expired?.status).toBe('expired')
    const memories = await memory.listAgentMemories({ limit: 50 })
    expect(memories.some((item) => item.key === '过期偏好')).toBe(false)

    const tool = tools.getTool('propose_action')
    const text = await tool?.execute(
      { type: 'save_memory', payload: { scope: 'user', key: '工具提案', value: '待确认' } },
      { sessionId: 9, turnId: 'turn-9' },
    )
    expect(text).toContain('待确认')
    const pending = await actions.listAgentActions({ status: 'proposed' })
    const fromTool = pending.find((item) => item.payload.key === '工具提案')
    expect(fromTool?.sessionId).toBe('9')
    expect(fromTool?.turnId).toBe('turn-9')
  })

  it('只读投研工具在无快照时给出可操作提示', async () => {
    const text = await tools.getTool('get_desk_snapshot')?.execute({})
    expect(text).toContain('还没有快照')
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
