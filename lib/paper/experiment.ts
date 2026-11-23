import crypto from 'crypto'
import { getDb } from '../db'
import {
  createPaperExperiment,
  getCurrentPaperExperiment,
  getPaperExperiment,
  getPaperExperimentPolicy,
  insertPaperExperiment,
  listPaperAccounts,
  PaperRepoError,
  writePaperAudit,
  type CreatedPaperExperiment,
  type PaperExperimentRow,
} from './repo'
import { DEFAULT_PAPER_POLICY, policyHash } from './policy'
import { addPaperTradingDays } from './calendar'

/**
 * 实验生命周期：暂停必须写原因，恢复沿用原计时，重置新建 -v2 实验。
 * 旧实验只读且保留全部账本；协议与政策版本随重置复制，不在原实验上改参数。
 */

type Row = Record<string, unknown>
type Tx = {
  execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Row[]; rowsAffected: number }>
}

const ACTOR = 'user'

export function paperProtocolHash(protocolJson: string): string {
  return crypto.createHash('sha256').update(protocolJson).digest('hex')
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString()
}

async function audit(
  conn: Tx,
  action: string,
  experimentId: string,
  payload: Record<string, unknown>,
  createdAt: string,
): Promise<void> {
  await writePaperAudit(conn, {
    actor: ACTOR,
    action,
    entityType: 'paper_experiment',
    entityId: experimentId,
    payload,
    createdAt,
  })
}

/** 旧实验里的在途卡在重置时统一作废；已确认委托必须先撤销或等结算。 */
async function closeOpenCards(tx: Tx, experimentId: string, now: string): Promise<number> {
  const open = await tx.execute({
    sql: `SELECT id FROM paper_decision_cards
          WHERE experiment_id = ? AND status IN ('active','triggered')`,
    args: [experimentId],
  })
  let closed = 0
  for (const row of open.rows) {
    const cardId = String(row.id)
    const guard = await tx.execute({
      sql: `UPDATE paper_decision_cards SET status = 'expired', updated_at = ?
            WHERE id = ? AND status IN ('active','triggered')`,
      args: [now, cardId],
    })
    if (!guard.rowsAffected) continue
    closed += 1
    await tx.execute({
      sql: `INSERT INTO paper_card_events
        (card_id, seq, event_type, from_status, to_status, payload_json, created_at)
        VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM paper_card_events WHERE card_id = ?),
                'experiment_reset', NULL, 'expired', ?, ?)`,
      args: [cardId, cardId, JSON.stringify({ experimentId }), now],
    })
  }
  return closed
}

export async function pausePaperExperiment(input: {
  experimentId: string
  reason: string
  now?: string
}): Promise<PaperExperimentRow> {
  const reason = input.reason?.trim()
  if (!reason) throw new PaperRepoError('INVALID_INPUT', '暂停必须填写原因')
  const experiment = await getPaperExperiment(input.experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', '实验不存在')
  if (experiment.status !== 'active') {
    throw new PaperRepoError('INVALID_STATE', '只有进行中的实验可以暂停')
  }

  const now = nowIso(input.now)
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    const guard = await tx.execute({
      sql: `UPDATE paper_experiments
            SET status = 'paused', pause_reason = ?, updated_at = ?
            WHERE id = ? AND status = 'active'`,
      args: [reason, now, experiment.id],
    })
    if (!guard.rowsAffected) throw new PaperRepoError('INVALID_STATE', '实验状态已变化，请刷新')
    await tx.execute({
      sql: `UPDATE paper_accounts SET status = 'paused'
            WHERE experiment_id = ? AND status = 'active'`,
      args: [experiment.id],
    })
    await audit(tx, 'experiment.paused', experiment.id, { reason }, now)
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }
  return (await getPaperExperiment(experiment.id)) as PaperExperimentRow
}

/** planned 实验开始计时；paused 实验恢复原 started_at，不因暂停重开观察期。 */
export async function startPaperExperiment(input: {
  experimentId: string
  now?: string
}): Promise<PaperExperimentRow> {
  const experiment = await getPaperExperiment(input.experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', '实验不存在')
  if (experiment.status === 'active') return experiment
  if (experiment.status !== 'planned' && experiment.status !== 'paused') {
    throw new PaperRepoError('INVALID_STATE', '只有未开始或已暂停的实验可以开始')
  }

  const now = nowIso(input.now)
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    const guard = await tx.execute({
      sql: `UPDATE paper_experiments
            SET status = 'active', pause_reason = NULL,
                started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE id = ? AND status IN ('planned','paused')`,
      args: [now, now, experiment.id],
    })
    if (!guard.rowsAffected) throw new PaperRepoError('INVALID_STATE', '实验状态已变化，请刷新')
    await tx.execute({
      sql: `UPDATE paper_accounts SET status = 'active'
            WHERE experiment_id = ? AND status = 'paused'`,
      args: [experiment.id],
    })
    await audit(tx, 'experiment.started', experiment.id, {
      from: experiment.status,
      protocolHash: paperProtocolHash(experiment.protocolJson),
    }, now)
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }
  return (await getPaperExperiment(experiment.id)) as PaperExperimentRow
}

function shanghaiDateOf(iso: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(iso))
}

export interface CreateDefaultPaperExperimentInput {
  name?: string
  initialCashCents?: number
  benchmarkCode?: string
  plannedTradingDays?: number
  protocolVersion?: string
  protocolNote?: string
  now?: string
}

const MIN_CASH_CENTS = 1_000_000      // ¥10,000
const MAX_CASH_CENTS = 1_000_000_000  // ¥10,000,000
const DEFAULT_CASH_CENTS = 20_000_000 // ¥200,000

/**
 * 新实验只锁服务端协议；客户端只能选资金档与基准，不能自带一份“更宽松”的协议。
 * 同一时间保留一个未结束实验，避免两个 active 抢“当前”上下文。
 */
export async function createDefaultPaperExperiment(
  input: CreateDefaultPaperExperimentInput = {},
): Promise<CreatedPaperExperiment> {
  const name = (input.name?.trim() || 'L1 前向纸面').trim()
  if (name.length > 80) throw new PaperRepoError('INVALID_INPUT', '实验名称最多 80 字')

  const cash = input.initialCashCents ?? DEFAULT_CASH_CENTS
  if (!Number.isSafeInteger(cash) || cash < MIN_CASH_CENTS || cash > MAX_CASH_CENTS) {
    throw new PaperRepoError('INVALID_INPUT', '初始资金须在 ¥10,000 至 ¥10,000,000 之间（整数分）')
  }

  const benchmarkCode = (input.benchmarkCode?.trim() || 'H00300').toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9._-]{1,23}$/.test(benchmarkCode)) {
    throw new PaperRepoError('INVALID_INPUT', '基准代码格式不正确')
  }
  const plannedTradingDays = input.plannedTradingDays ?? 250
  if (!Number.isSafeInteger(plannedTradingDays) || plannedTradingDays < 1 || plannedTradingDays > 1_000) {
    throw new PaperRepoError('INVALID_INPUT', '计划交易日须为 1–1000 的整数')
  }
  const protocolVersion = (input.protocolVersion?.trim() || 'v1').trim()
  if (protocolVersion.length > 32) throw new PaperRepoError('INVALID_INPUT', '协议版本最多 32 字')
  const protocolNote = input.protocolNote?.trim() || null
  if (protocolNote && protocolNote.length > 500) {
    throw new PaperRepoError('INVALID_INPUT', '协议备注最多 500 字')
  }

  // 参数错误先于状态检查报出来，避免用户以为只是“已有实验”而改错方向。
  const current = await getCurrentPaperExperiment()
  if (current) {
    throw new PaperRepoError('INVALID_STATE', '已有未结束的实验，请先暂停、重置或关闭', {
      experimentId: current.id,
      status: current.status,
    })
  }

  const now = nowIso(input.now)
  const startDate = shanghaiDateOf(now)
  const plannedEndDate = await addPaperTradingDays(startDate, plannedTradingDays)
  const benchmarkBasis = /^H0\d{4}$/i.test(benchmarkCode) ? 'total_return_index' : 'price_index'
  const protocol = {
    version: 'paper-protocol-v1',
    lockedAt: now,
    objective: '用真实 A 股数据、虚拟资金和官方开盘价纸面成交，检验这套投研方法是否值得继续投入。',
    scope: '沪深主板、创业板、科创板；不接券商、不碰真钱、不构成投资建议。',
    initialCashCents: cash,
    benchmark: { code: benchmarkCode, basis: benchmarkBasis },
    plannedTradingDays,
    dailyRhythm: {
      preopen: '08:30',
      confirmCutoff: '09:15',
      settle: '16:20',
      nav: '16:30',
      review: '17:00',
      outcomes: '17:15',
      nextDayCards: '17:30',
      weekly: 'Saturday 10:00',
    },
    gates: {
      L1_TO_L2: {
        minValidDays: 120,
        minLastCardAgeDays: 60,
        minTriggeredCards: 30,
        minTotal: 80,
        minDimensionRatioBp: 6_000,
        vetoes: ['lookahead', 'reconciliation', 'compliance'],
      },
      L2_TO_L3: {
        minValidDays: 250,
        minTriggeredCards: 100,
        requireCalibration: true,
        maxDrawdownBp: 1_000,
        minSharpe: 0.5,
        minTotal: 80,
        minDimensionRatioBp: 6_000,
        vetoes: ['lookahead', 'reconciliation', 'compliance'],
      },
    },
    rules: {
      noRealOrders: true,
      noLookahead: true,
      officialOpenSettlement: true,
      resetDoesNotChangePolicy: true,
      below120Days: 'counts_only',
    },
    notes: protocolNote,
  }
  const baseline = {
    benchmarkCode,
    benchmarkBasis,
    initialCashCents: cash,
    cashCents: cash,
    capturedAt: now,
  }

  return createPaperExperiment({
    name,
    protocolVersion,
    benchmarkCode,
    initialCashCents: cash,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: now,
    plannedEndAt: `${plannedEndDate}T15:00:00+08:00`,
    protocol,
    baseline,
    config: {
      plannedTradingDays,
      plannedEndDate,
      benchmarkBasis,
      createdVia: 'api',
    },
    now,
  })
}

function nextExperimentName(name: string, generation: number): string {
  const suffix = `-v${generation}`
  return /-v\d+$/.test(name) ? name.replace(/-v\d+$/, suffix) : `${name}${suffix}`
}

function plannedEndAfterReset(old: PaperExperimentRow, now: string): string | null {
  if (!old.plannedEndAt || !old.startedAt) return old.plannedEndAt
  const span = Date.parse(old.plannedEndAt) - Date.parse(old.startedAt)
  if (!Number.isFinite(span) || span <= 0) return null
  return new Date(Date.parse(now) + span).toISOString()
}

export interface ResetPaperExperimentResult {
  previous: PaperExperimentRow
  created: CreatedPaperExperiment
  openCardsExpired: number
}

/** 重置 = 旧实验 closed 只读 + 新实验 reset_of 指回旧实验 + 计时重开。 */
export async function resetPaperExperiment(input: {
  experimentId: string
  now?: string
  name?: string
}): Promise<ResetPaperExperimentResult> {
  const old = await getPaperExperiment(input.experimentId)
  if (!old) throw new PaperRepoError('NOT_FOUND', '实验不存在')
  if (old.status !== 'active' && old.status !== 'paused') {
    throw new PaperRepoError('INVALID_STATE', '只有进行中或已暂停的实验可以重置')
  }

  const now = nowIso(input.now)
  const db = await getDb()
  const open = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM paper_orders
          WHERE experiment_id = ? AND status IN ('confirmed','settlement_pending')`,
    args: [old.id],
  })
  if (Number(open.rows[0]?.n) > 0) {
    throw new PaperRepoError('INVALID_STATE', '仍有未结束的委托，请先撤销或等待结算后再重置', {
      openOrders: Number(open.rows[0]?.n),
    })
  }

  const generation = old.resetCount + 1
  const name = (input.name?.trim() || nextExperimentName(old.name, generation + 1)).trim()
  const protocol = JSON.parse(old.protocolJson || '{}') as Record<string, unknown>
  const baseline = JSON.parse(old.baselineJson || '{}') as Record<string, unknown>
  const config = JSON.parse(old.configJson || '{}') as Record<string, unknown>
  // 规则、费用、基准随重置原样复制；换参数必须另建实验，不能借重置悄悄改。
  const { policy } = await getPaperExperimentPolicy(old.id)

  let openCardsExpired = 0
  let newExperimentId = ''
  const tx = await db.transaction('write')
  try {
    const guard = await tx.execute({
      sql: `UPDATE paper_experiments
            SET status = 'closed', ended_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('active','paused')`,
      args: [now, now, old.id],
    })
    if (!guard.rowsAffected) throw new PaperRepoError('INVALID_STATE', '实验状态已变化，请刷新')
    await tx.execute({
      sql: `UPDATE paper_accounts SET status = 'closed', closed_at = ?
            WHERE experiment_id = ? AND status <> 'closed'`,
      args: [now, old.id],
    })
    openCardsExpired = await closeOpenCards(tx, old.id, now)

    const inserted = await insertPaperExperiment(tx, {
      name,
      protocolVersion: old.protocolVersion,
      benchmarkCode: old.benchmarkCode,
      initialCashCents: old.initialCashCents,
      policy,
      startedAt: now,
      plannedEndAt: plannedEndAfterReset(old, now),
      protocol,
      baseline,
      config: { ...config, resetFrom: old.id, generation },
      now,
    })
    newExperimentId = inserted.experimentId
    await tx.execute({
      sql: 'UPDATE paper_experiments SET reset_count = ?, reset_of = ? WHERE id = ?',
      args: [generation, old.id, newExperimentId],
    })
    for (const [kind, accountId] of Object.entries(inserted.accountIds)) {
      const label = kind === 'shadow' ? '影子账户' : '主账户'
      await tx.execute({
        sql: 'UPDATE paper_accounts SET name = ? WHERE id = ?',
        args: [`${label} v${generation + 1}`, accountId],
      })
    }
    await audit(tx, 'experiment.reset', old.id, {
      newExperimentId,
      generation,
      openCardsExpired,
      protocolHash: paperProtocolHash(old.protocolJson),
    }, now)
    await audit(tx, 'experiment.reset.created', old.id, {
      newExperimentId,
      generation,
      name,
    }, now)
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }

  const created = await getPaperExperiment(newExperimentId)
  if (!created) throw new PaperRepoError('NOT_FOUND', '重置后的实验读取失败')
  return {
    previous: (await getPaperExperiment(old.id)) as PaperExperimentRow,
    created: {
      experiment: created,
      accounts: await listPaperAccounts(newExperimentId),
      policyVersion: policy.version,
      policyHash: policyHash(policy),
    },
    openCardsExpired,
  }
}

export interface PaperExperimentHistoryItem {
  id: string
  name: string
  status: PaperExperimentRow['status']
  resetCount: number
  resetOf: string | null
  validDays: number
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

/** 沿 reset_of 链回溯并向前展开，给 UI 展示版本谱系。 */
export async function listPaperExperimentHistory(experimentId: string): Promise<PaperExperimentHistoryItem[]> {
  const db = await getDb()
  const rows = await db.execute({
    sql: `WITH RECURSIVE lineage(id) AS (
            SELECT id FROM paper_experiments WHERE id = ?
            UNION
            SELECT e.reset_of FROM paper_experiments e
              JOIN lineage l ON e.id = l.id WHERE e.reset_of IS NOT NULL
            UNION
            SELECT e.id FROM paper_experiments e
              JOIN lineage l ON e.reset_of = l.id WHERE e.reset_of IS NOT NULL
          )
          SELECT id, name, status, reset_count, reset_of, valid_days, started_at, ended_at, created_at
          FROM paper_experiments WHERE id IN (SELECT id FROM lineage)
          ORDER BY created_at, id`,
    args: [experimentId],
  })
  return rows.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    status: String(row.status) as PaperExperimentRow['status'],
    resetCount: Number(row.reset_count),
    resetOf: row.reset_of == null ? null : String(row.reset_of),
    validDays: Number(row.valid_days),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    createdAt: String(row.created_at),
  }))
}


