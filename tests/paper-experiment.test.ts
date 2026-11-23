import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

/**
 * 实验生命周期：暂停必须写原因、恢复沿用原计时、重置新开 -v2 并关闭旧实验。
 * 在途委托会阻止重置，防止旧账本留下无法解释的状态。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-experiment-test-'))
const START = '2026-06-01T00:00:00.000Z'
const PAUSE_AT = '2026-06-03T00:00:00.000Z'
const RESUME_AT = '2026-06-05T00:00:00.000Z'
const RESET_AT = '2026-06-08T00:00:00.000Z'
const PROTOCOL = { rules: 'v1', note: '冻结协议' }

let db: any
let repo: typeof import('../lib/paper/repo')
let lifecycle: typeof import('../lib/paper/experiment')
let experimentId = ''

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = path.join(dir, 'experiment.db')
  vi.resetModules()
  const dbMod = await import('../lib/db')
  db = await dbMod.getDb()
  repo = await import('../lib/paper/repo')
  lifecycle = await import('../lib/paper/experiment')

  const created = await repo.createPaperExperiment({
    name: '生命周期测试',
    protocolVersion: 'v1',
    benchmarkCode: 'H00300',
    initialCashCents: 20_000_000,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: START,
    plannedEndAt: '2026-12-01T00:00:00.000Z',
    protocol: PROTOCOL,
    now: START,
  })
  experimentId = created.experiment.id
})

afterAll(async () => {
  await db.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('实验生命周期', () => {
  it('暂停必须写原因，暂停后账户同步只读', async () => {
    await expect(lifecycle.pausePaperExperiment({ experimentId, reason: '  ' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const paused = await lifecycle.pausePaperExperiment({
      experimentId,
      reason: '数据源中断',
      now: PAUSE_AT,
    })
    expect(paused.status).toBe('paused')
    expect(paused.pauseReason).toBe('数据源中断')
    const accounts = await repo.listPaperAccounts(experimentId)
    expect(accounts.map((a) => a.status)).toEqual(['paused', 'paused'])

    const auditRows = await db.execute({
      sql: "SELECT action, payload_json FROM paper_audit_log WHERE action = 'experiment.paused'",
      args: [],
    })
    expect(auditRows.rows).toHaveLength(1)
    expect(JSON.parse(auditRows.rows[0].payload_json).reason).toBe('数据源中断')
  })

  it('恢复沿用原开始时间，不清空已累计的有效天数', async () => {
    const before = await repo.getPaperExperiment(experimentId)
    await db.execute({
      sql: 'UPDATE paper_experiments SET valid_days = 7 WHERE id = ?',
      args: [experimentId],
    })
    const resumed = await lifecycle.startPaperExperiment({ experimentId, now: RESUME_AT })
    expect(resumed.status).toBe('active')
    expect(resumed.startedAt).toBe(START)
    expect(resumed.validDays).toBe(7)
    expect(resumed.pauseReason).toBeNull()
    expect(resumed.protocolJson).toBe(before!.protocolJson)
    const accounts = await repo.listPaperAccounts(experimentId)
    expect(accounts.map((a) => a.status)).toEqual(['active', 'active'])
  })

  it('在途委托存在时拒绝重置', async () => {
    await db.execute({
      sql: `INSERT INTO paper_orders
        (id, experiment_id, account_id, card_id, actor, symbol_code, side, order_type, qty,
         status, client_request_id, idempotency_key, request_hash, target_trade_date,
         confirmed_at, created_at, updated_at)
        VALUES ('order-open', ?, ?, NULL, 'user', '600000.SH', 'sell', 'open_market', 100,
                'confirmed', 'req-open', 'idem-open', 'hash', '2026-06-09',
                ?, ?, ?)`,
      args: [
        experimentId,
        (await repo.listPaperAccounts(experimentId)).find((a) => a.kind === 'user')!.id,
        RESET_AT, RESET_AT, RESET_AT,
      ],
    })
    await expect(lifecycle.resetPaperExperiment({ experimentId, now: RESET_AT }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
    await db.execute({
      sql: "UPDATE paper_orders SET status = 'canceled' WHERE id = 'order-open'",
      args: [],
    })
  })

  it('重置关闭旧实验并新建 -v2，协议与政策原样锁定', async () => {
    const before = await repo.getPaperExperiment(experimentId)
    const protocolHash = lifecycle.paperProtocolHash(before!.protocolJson)
    const result = await lifecycle.resetPaperExperiment({ experimentId, now: RESET_AT })

    expect(result.previous.status).toBe('closed')
    expect(result.previous.endedAt).toBe(RESET_AT)
    expect(result.previous.resetCount).toBe(0)

    const next = result.created.experiment
    expect(next.status).toBe('active')
    expect(next.name).toBe('生命周期测试-v2')
    expect(next.resetOf).toBe(experimentId)
    expect(next.resetCount).toBe(1)
    expect(next.protocolJson).toBe(before!.protocolJson)
    expect(next.protocolVersion).toBe(before!.protocolVersion)
    expect(next.policyVersion).toBe(before!.policyVersion)
    expect(next.benchmarkCode).toBe(before!.benchmarkCode)
    expect(next.initialCashCents).toBe(before!.initialCashCents)
    expect(next.startedAt).toBe(RESET_AT)
    expect(next.plannedEndAt).toBe('2026-12-08T00:00:00.000Z')
    expect(lifecycle.paperProtocolHash(next.protocolJson)).toBe(protocolHash)

    const oldAccounts = await repo.listPaperAccounts(experimentId)
    expect(oldAccounts.every((a) => a.status === 'closed')).toBe(true)
    const newAccounts = result.created.accounts
    expect(newAccounts.map((a) => a.kind).sort()).toEqual(['shadow', 'user'])
    expect(newAccounts.every((a) => a.status === 'active')).toBe(true)
    expect(newAccounts.map((a) => a.name).sort()).toEqual(['主账户 v2', '影子账户 v2'])

    const auditRows = await db.execute({
      sql: "SELECT action, payload_json FROM paper_audit_log WHERE action LIKE 'experiment.reset%' ORDER BY id",
      args: [],
    })
    expect(auditRows.rows.map((r: any) => r.action)).toEqual([
      'experiment.reset',
      'experiment.reset.created',
    ])
    expect(JSON.parse(auditRows.rows[0].payload_json).newExperimentId).toBe(next.id)
  })

  it('重置谱系可回溯，旧实验不能再暂停或重置', async () => {
    const active = await repo.getPaperExperiment(experimentId)
    expect(active?.status).toBe('closed')
    await expect(lifecycle.pausePaperExperiment({ experimentId, reason: '重复操作' }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(lifecycle.resetPaperExperiment({ experimentId }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' })

    const latest = (await db.execute({
      sql: 'SELECT id FROM paper_experiments WHERE reset_of = ?',
      args: [experimentId],
    })).rows[0].id as string
    const history = await lifecycle.listPaperExperimentHistory(latest)
    expect(history).toHaveLength(2)
    expect(history[0].id).toBe(experimentId)
    expect(history[1].id).toBe(latest)
    expect(history[1].resetOf).toBe(experimentId)
  })
})
