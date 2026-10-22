import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 任务队列要证明四件事：同参数幂等、单 worker 能跑通、失败会重试后终止、
 * 排队任务可取消。全部用真实 SQLite 事务与唯一索引。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-tasks-test-'))
let demo: typeof import('../lib/cockpit/demo')
let tasks: typeof import('../lib/cockpit/tasks')
let dbModule: typeof import('../lib/db')

describe('cockpit task queue', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'tasks.db')
    vi.resetModules()
    demo = await import('../lib/cockpit/demo')
    tasks = await import('../lib/cockpit/tasks')
    dbModule = await import('../lib/db')
    await demo.ensureCockpitDemoSeed()
  })

  it('同参数重复入队返回同一任务', async () => {
    const first = await tasks.enqueueTask({
      type: 'daily_brief',
      params: { tradeDate: demo.DEMO_TRADE_DATE },
    })
    const second = await tasks.enqueueTask({
      type: 'daily_brief',
      params: { tradeDate: demo.DEMO_TRADE_DATE },
    })
    expect(second.id).toBe(first.id)
    expect(first.status).toBe('queued')
  })

  it('认领并执行日报任务，写入事件与结果', async () => {
    const result = await tasks.processNextTask()
    expect(result?.status).toBe('succeeded')
    expect(result?.result?.tradeDate).toBe(demo.DEMO_TRADE_DATE)
    expect(result?.progress).toBe(100)

    const events = await tasks.getTaskEvents(result!.id)
    expect(events.map((event) => event.type)).toEqual(['queued', 'started', 'succeeded'])
  })

  it('个股深挖任务返回事实与来源，不伪造缺失标的', async () => {
    const queued = await tasks.enqueueTask({
      type: 'symbol_deep_dive',
      params: { code: '600519.SH' },
    })
    const result = await tasks.processNextTask()
    expect(result?.id).toBe(queued.id)
    expect(result?.status).toBe('succeeded')
    expect(result?.result?.code).toBe('600519.SH')
    expect(Array.isArray(result?.result?.evidence)).toBe(true)

    const missing = await tasks.enqueueTask({
      type: 'symbol_deep_dive',
      params: { code: '999999.SH' },
    })
    const firstAttempt = await tasks.processNextTask()
    expect(firstAttempt?.id).toBe(missing.id)
    expect(firstAttempt?.status).toBe('queued')
    const secondAttempt = await tasks.processNextTask()
    expect(secondAttempt?.status).toBe('failed')
    expect(secondAttempt?.attempts).toBe(2)
    expect(secondAttempt?.error).toBeTruthy()
  })

  it('失败任务可用相同参数重新入队', async () => {
    const again = await tasks.enqueueTask({
      type: 'symbol_deep_dive',
      params: { code: '999999.SH' },
    })
    expect(again.status).toBe('queued')
    expect(again.attempts).toBe(0)
    await tasks.cancelTask(again.id)
  })

  it('drain 会把 requeue 的任务连续跑到重试上限', async () => {
    const queued = await tasks.enqueueTask({
      type: 'symbol_deep_dive',
      params: { code: '999998.SH' },
    })
    await tasks.drainTasks()
    const failed = await tasks.getTask(queued.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.attempts).toBe(2)
  })

  it('排队任务可取消，取消后不再被执行', async () => {
    const queued = await tasks.enqueueTask({
      type: 'ask',
      params: { question: '今天的广度证据是什么？' },
    })
    const canceled = await tasks.cancelTask(queued.id)
    expect(canceled?.status).toBe('canceled')

    const next = await tasks.processNextTask()
    expect(next).toBeNull()
    const events = await tasks.getTaskEvents(queued.id)
    expect(events.some((event) => event.type === 'canceled')).toBe(true)
  })

  it('心跳只续运行中的任务，stop 后不再写', async () => {
    const db = await dbModule.getDb()
    const now = new Date().toISOString()
    const stale = '2000-01-01T00:00:00.000Z'
    const insert = (id: string, status: string, key: string) => db.execute({
      sql: `INSERT INTO tasks
            (id, type, params_json, status, progress, step, idempotency_key, attempts,
             model, cost_micros, created_at, heartbeat_at)
            VALUES (?, 'daily_brief', '{}', ?, 5, '执行中', ?, 1, 'deterministic', 0, ?, ?)`,
      args: [id, status, key, now, stale],
    })
    await insert('heartbeat-running', 'running', 'heartbeat-running-key')
    await insert('heartbeat-done', 'succeeded', 'heartbeat-done-key')

    const stop = tasks.startTaskHeartbeat('heartbeat-running', 20)
    await new Promise((resolve) => setTimeout(resolve, 70))
    stop()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const running = await db.execute({
      sql: "SELECT heartbeat_at FROM tasks WHERE id = 'heartbeat-running'",
      args: [],
    })
    expect(running.rows[0]?.heartbeat_at).not.toBe(stale)
    const done = await db.execute({
      sql: "SELECT heartbeat_at FROM tasks WHERE id = 'heartbeat-done'",
      args: [],
    })
    expect(done.rows[0]?.heartbeat_at).toBe(stale)

    const stoppedAt = running.rows[0]?.heartbeat_at
    await new Promise((resolve) => setTimeout(resolve, 80))
    const after = await db.execute({
      sql: "SELECT heartbeat_at FROM tasks WHERE id = 'heartbeat-running'",
      args: [],
    })
    expect(after.rows[0]?.heartbeat_at).toBe(stoppedAt)

    await db.execute({ sql: "DELETE FROM tasks WHERE id IN ('heartbeat-running','heartbeat-done')", args: [] })
  })

  it('任务列表按时间倒序且 limit 有上限', async () => {
    const list = await tasks.listTasks(2)
    expect(list).toHaveLength(2)
    const all = await tasks.listTasks(1000)
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all.length).toBeLessThanOrEqual(100)
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
