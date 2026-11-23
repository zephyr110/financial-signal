import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 总览聚合：没有实验时返回 setupRequired 而不是 404；默认创建只锁服务端协议；
 * 暂停后总览直接给 resume，不依赖前端猜状态。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-summary-test-'))
const NOW = '2026-06-01T00:00:00.000Z'

let db: any
let summaryMod: typeof import('../lib/paper/summary')
let lifecycle: typeof import('../lib/paper/experiment')

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = path.join(dir, 'summary.db')
  vi.resetModules()
  const dbMod = await import('../lib/db')
  db = await dbMod.getDb()
  summaryMod = await import('../lib/paper/summary')
  lifecycle = await import('../lib/paper/experiment')
})

afterAll(async () => {
  await db.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('模拟盘总览', () => {
  it('没有实验时返回 setupRequired 与创建引导', async () => {
    const summary = await summaryMod.buildPaperSummary({ now: NOW })
    expect(summary.setupRequired).toBe(true)
    expect(summary.experiment).toBeNull()
    expect(summary.today.action).toBe('setup')
    expect(summary.accounts).toEqual([])
    expect(summary.generatedAt).toBe(NOW)
  })

  it('默认创建锁定服务端协议，默认资金与基准符合规格', async () => {
    const created = await lifecycle.createDefaultPaperExperiment({ now: NOW })
    expect(created.experiment.status).toBe('active')
    expect(created.experiment.benchmarkCode).toBe('H00300')
    expect(created.experiment.initialCashCents).toBe(20_000_000)
    expect(created.experiment.protocolVersion).toBe('v1')
    expect(created.accounts.map((a) => a.kind).sort()).toEqual(['shadow', 'user'])

    const protocol = JSON.parse(created.experiment.protocolJson)
    expect(protocol.version).toBe('paper-protocol-v1')
    expect(protocol.benchmark).toEqual({ code: 'H00300', basis: 'total_return_index' })
    expect(protocol.gates.L1_TO_L2.minValidDays).toBe(120)
    expect(protocol.gates.L2_TO_L3.minTriggeredCards).toBe(100)
    expect(protocol.rules.noRealOrders).toBe(true)

    const config = JSON.parse(created.experiment.configJson)
    expect(config.plannedTradingDays).toBe(250)
    expect(config.benchmarkBasis).toBe('total_return_index')
    expect(config.createdVia).toBe('api')
    expect(config.plannedEndDate > '2026-06-01').toBe(true)
  })

  it('已有未结束实验时拒绝再建，避免两个 active', async () => {
    await expect(lifecycle.createDefaultPaperExperiment({ now: NOW }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('资金档与基准代码做边界校验', async () => {
    await expect(lifecycle.createDefaultPaperExperiment({ initialCashCents: 999 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(lifecycle.createDefaultPaperExperiment({ initialCashCents: 20_000_000.5 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(lifecycle.createDefaultPaperExperiment({ benchmarkCode: 'not a code' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('有实验时总览返回账户与待办；暂停后直接给恢复动作', async () => {
    const active = await summaryMod.buildPaperSummary()
    expect(active.setupRequired).toBe(false)
    expect(active.experiment?.benchmarkCode).toBe('H00300')
    expect(active.accounts).toHaveLength(2)
    expect(active.today.headline.length).toBeGreaterThan(0)
    expect(active.today.todos.length).toBeGreaterThan(0)

    const experiment = active.experiment!
    await lifecycle.pausePaperExperiment({ experimentId: experiment.id, reason: '数据源核验中' })
    const paused = await summaryMod.buildPaperSummary()
    expect(paused.today.action).toBe('resume')
    expect(paused.experiment?.status).toBe('paused')
    expect(paused.accounts.map((a) => a.status)).toEqual(['paused', 'paused'])
  })
})
