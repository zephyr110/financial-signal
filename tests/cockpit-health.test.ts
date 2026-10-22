import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 来源健康度语义：停用但带历史错误的适配器是“未接入”，不是“异常”；
 * 启用却从未成功抓取才是“滞后”。这决定数据质量面板会不会长期误报红点。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-health-test-'))
let repo: typeof import('../lib/cockpit/repo')
let dbModule: typeof import('../lib/db')

describe('cockpit source health', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'health.db')
    vi.resetModules()
    const demo = await import('../lib/cockpit/demo')
    repo = await import('../lib/cockpit/repo')
    dbModule = await import('../lib/db')
    await demo.ensureCockpitDemoSeed()
  })

  it('停用官方源是未接入，示例源保持示例', async () => {
    const health = await repo.getSourceHealth()
    expect(health.find((source) => source.id === 'cninfo')?.status).toBe('inactive')
    expect(health.find((source) => source.id === 'sse')?.status).toBe('inactive')
    const demo = health.filter((source) => source.id.startsWith('demo-'))
    expect(demo.length).toBeGreaterThan(0)
    expect(demo.every((source) => source.status === 'demo')).toBe(true)
  })

  it('启用但从未成功抓取 → 滞后', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `UPDATE source_registry
            SET enabled = 1, last_error = NULL, last_success_at = NULL
            WHERE id = 'cninfo'`,
      args: [],
    })
    const health = await repo.getSourceHealth()
    expect(health.find((source) => source.id === 'cninfo')?.status).toBe('stale')
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
