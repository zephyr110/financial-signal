import path from 'path'
import os from 'os'
import fs from 'fs'
import crypto from 'crypto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

/**
 * P10：预警深挖的预算、降级、证据引用、去重与反馈。
 */

const mock = vi.hoisted(() => {
  const state = { apiKey: '', replies: [] as string[] }
  return {
    state,
    chatCompletion: vi.fn(async () => ({
      content: state.replies.shift() || '已完成核查。',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })),
    getEffectiveLlmConfig: vi.fn(async () => ({
      apiKey: state.apiKey,
      baseUrl: 'https://example.com/v1',
      model: 'test-model',
    })),
  }
})

vi.mock('../lib/llm/client', () => ({ chatCompletion: mock.chatCompletion }))
vi.mock('../lib/llm/config', () => ({
  getEffectiveLlmConfig: mock.getEffectiveLlmConfig,
  PRICING: { inputPerMillion: 1, outputPerMillion: 2, currency: '¥' },
}))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-investigation-test-'))
let demo: typeof import('../lib/cockpit/demo')
let engine: typeof import('../lib/desk/engine')
let repo: typeof import('../lib/desk/repo')
let dbModule: typeof import('../lib/db')
let inv: typeof import('../lib/desk/investigation')
let format: typeof import('../lib/cockpit/format')

const failingFetch = (async () => new Response('', { status: 503 })) as typeof fetch
let alertId = ''
let alertIndustry = ''

describe('desk investigation', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.LLM_API_KEY
    process.env.NEWS_DB_PATH = path.join(dir, 'investigation.db')
    vi.resetModules()
    demo = await import('../lib/cockpit/demo')
    engine = await import('../lib/desk/engine')
    repo = await import('../lib/desk/repo')
    dbModule = await import('../lib/db')
    inv = await import('../lib/desk/investigation')
    format = await import('../lib/cockpit/format')
    await demo.ensureCockpitDemoSeed()
    await engine.refreshDesk({ tradeDate: demo.DEMO_TRADE_DATE, fetchImpl: failingFetch })
    const alerts = await repo.listAlerts({ status: 'open', limit: 10 })
    const target = alerts.find((alert) => alert.industry) || alerts[0]
    alertId = target.id
    alertIndustry = target.industry || ''
  })

  beforeEach(() => {
    mock.state.apiKey = ''
    mock.state.replies = []
    mock.chatCompletion.mockClear()
  })

  it('触发评分随严重度、类别、证据与行业递增', () => {
    const low = inv.investigationTrigger({ severity: 'info', category: 'other', evidence: [] })
    const high = inv.investigationTrigger({
      severity: 'critical',
      category: 'policy',
      industry: '半导体',
      evidence: [{}, {}],
    })
    expect(high.score).toBeGreaterThan(low.score)
    expect(high.reasons.length).toBeGreaterThanOrEqual(3)
  })

  it('无 LLM 时确定性降级：结论带证据引用并成功收口', async () => {
    const { investigation, created } = await inv.createInvestigation({ alertId, manual: true })
    expect(created).toBe(true)
    expect(investigation.status).toBe('queued')
    expect(investigation.question).toContain('核实预警')
    expect(investigation.alertId).toBe(alertId)

    const done = await inv.runInvestigation(investigation.id)
    expect(done.status).toBe('succeeded')
    expect(done.conclusion).toContain('证据引用')
    expect(done.conclusion).toContain(alertIndustry)
    expect(done.steps.some((step) => step.kind === 'evidence')).toBe(true)
    expect(done.steps.some((step) => step.kind === 'conclusion')).toBe(true)
    expect(done.confidence).toBeTruthy()
    expect(done.evidenceStrength).toBeTruthy()
    expect(done.progress).toBe(100)
    expect(mock.chatCompletion).not.toHaveBeenCalled()
  })

  it('同一预警同一天重复深挖复用既有调查', async () => {
    const again = await inv.createInvestigation({ alertId, manual: true })
    expect(again.created).toBe(false)
    const items = await inv.listInvestigations({ limit: 10 })
    expect(items.filter((item) => item.alertId === alertId && item.status === 'succeeded')).toHaveLength(1)
  })

  it('自动深挖按刷新交易日去重，服务端按 alertId 精确查找', async () => {
    const first = await inv.createInvestigation({ alertId, manual: false, dedupeDate: '2026-01-05' })
    expect(first.created).toBe(true)
    const sameDay = await inv.createInvestigation({ alertId, manual: false, dedupeDate: '2026-01-05' })
    expect(sameDay.created).toBe(false)
    expect(sameDay.investigation.id).toBe(first.investigation.id)
    const nextDay = await inv.createInvestigation({ alertId, manual: false, dedupeDate: '2026-01-06' })
    expect(nextDay.created).toBe(true)

    const found = await inv.listInvestigations({ alertId, limit: 1 })
    expect(found).toHaveLength(1)
    expect(found[0].alertId).toBe(alertId)
  })

  it('有 LLM 时按预算调用只读工具，工具引用进入结论', async () => {
    mock.state.apiKey = 'test-key'
    mock.state.replies = [
      JSON.stringify({ tool: 'get_industry_metrics', args: { industry: alertIndustry } }),
      '行业与文档证据同向，仍需跟踪后续广度变化。',
    ]

    const alerts = await repo.listAlerts({ status: 'open', limit: 10 })
    const target = alerts.find((alert) => alert.id !== alertId) || alerts[0]
    const db = await dbModule.getDb()
    // 制造独立目标，避免命中上一条人工调查的当日去重
    await db.execute({ sql: 'DELETE FROM desk_investigations WHERE alert_id = ?', args: [target.id] })
    const { investigation } = await inv.createInvestigation({ alertId: target.id, manual: true })
    const done = await inv.runInvestigation(investigation.id)

    expect(done.status).toBe('succeeded')
    expect(mock.chatCompletion.mock.calls.length).toBe(2)
    const toolStep = done.steps.find((step) => step.kind === 'tool')
    expect(toolStep?.tool).toBe('get_industry_metrics')
    expect(toolStep?.refs.length).toBeGreaterThan(0)
    expect(done.tokensUsed).toBeGreaterThan(0)
    expect(done.costMicros).toBeGreaterThan(0)
    expect(done.conclusion).toContain('证据引用')
    expect(done.steps.some((step) => step.refs.length > 0)).toBe(true)
  })

  it('调查反馈可写回', async () => {
    const items = await inv.listInvestigations({ limit: 1 })
    expect(await inv.setInvestigationFeedback(items[0].id, 'useful')).toBe(true)
    const updated = await inv.getInvestigation(items[0].id)
    expect(updated?.feedback).toBe('useful')
    expect(await inv.setInvestigationFeedback('missing', 'wrong')).toBe(false)
  })

  it('自动深挖只挑高分预警，且当天不重复入队', async () => {
    const db = await dbModule.getDb()
    const id = crypto.randomUUID()
    await db.execute({
      sql: `INSERT INTO alerts
              (id, trade_date, dedupe_key, severity, category, industry, title, summary, why_now,
               evidence_json, status, triggered_at)
            VALUES (?, ?, ?, 'critical', 'policy', ?, '政策测试预警', '摘要', '刚触发', ?, 'open', ?)`,
      args: [
        id,
        format.todayShanghai(),
        `test:${id}`,
        alertIndustry || '半导体',
        JSON.stringify([{ id: 'e1', label: '证据一' }, { id: 'e2', label: '证据二' }]),
        new Date().toISOString(),
      ],
    })

    const first = await inv.queueAutoInvestigations()
    expect(first.length).toBeGreaterThan(0)
    const all = await inv.listInvestigations({ limit: 20 })
    const created = all.find((item) => item.alertId === id)
    expect(created).toBeTruthy()
    expect(created?.triggerReason).toContain('自动深挖')

    const second = await inv.queueAutoInvestigations()
    expect(second).toHaveLength(0)
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
