import crypto from 'crypto'
import { getDb } from '../db'
import { dateShanghai, todayShanghai } from '../cockpit/format'
import { weeklyPeriodEnd } from '../cockpit/market-hours'
import { paperRequestHash } from './api'
import {
  addCalendarDays,
  addPaperTradingDays,
  ensurePaperCalendar,
  hasMarketDataForDate,
  isPaperTradingDay,
  nextPaperTradingDate,
  previousPaperTradingDate,
} from './calendar'
import { buildDecisionCard, sizePositionCents, validateDecisionCardDraft } from './cards'
import { loadPaperFeatureBundle, type HeldPositionInput } from './features'
import { derivePositions, portfolioMarketValue } from './ledger'
import { calcFees } from './market'
import { ensurePaperMarketData } from './market-data'
import { resolvePaperBenchmarkCode } from './metrics'
import { syncPaperSymbolMeta, syncPaperUniverse } from './meta'
import { confirmPaperOrder, freezePaperOrders, settlePaperOrders } from './orders'
import { stableStringify } from './policy'
import {
  clearPaperMissingPriceState,
  getPaperAccount,
  getPaperExperiment,
  getPaperExperimentPolicy,
  getPaperNavCents,
  getPaperRiskState,
  listPaperAccounts,
  loadClosePriceCents,
  loadLatestClosePriceCents,
  loadPaperLedger,
  loadPaperSymbolContext,
  PaperRepoError,
  recordPaperNav,
  recordPaperRiskEvent,
  reconcilePaperAccount,
  type PaperAccountRow,
  type PaperExperimentRow,
} from './repo'
import type { DataQuality, PaperPolicy } from './types'

/**
 * 模拟盘每日节奏：17:30 生成次日卡、08:30 盘前复核与影子执行、09:15 截止、
 * 16:20 结算、16:30 估值对账、17:00/周六复盘、17:15 到期评估。
 * 所有步骤幂等；非交易日直接跳过，不生成空报告。
 */

type Row = Record<string, unknown>
const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

export interface PaperJobResult {
  skipped: boolean
  reason?: string
  tradeDate: string
  detail: Record<string, unknown>
}

async function activeExperiment(experimentId?: string | null): Promise<PaperExperimentRow | null> {
  if (experimentId) {
    const experiment = await getPaperExperiment(experimentId)
    return experiment && experiment.status === 'active' ? experiment : null
  }
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT id FROM paper_experiments WHERE status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
    args: [],
  })
  return r.rows.length ? getPaperExperiment(str(r.rows[0].id)) : null
}

/** 暂停只停止新增决策；截止仍要跑，否则已确认委托会一直挂在 confirmed 上无法收口。 */
async function experimentForOperations(experimentId?: string | null): Promise<PaperExperimentRow | null> {
  if (experimentId) {
    const experiment = await getPaperExperiment(experimentId)
    return experiment && (experiment.status === 'active' || experiment.status === 'paused') ? experiment : null
  }
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT id FROM paper_experiments WHERE status IN ('active','paused')
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    args: [],
  })
  return r.rows.length ? getPaperExperiment(str(r.rows[0].id)) : null
}

/** 手动触发接口也要守住时点：不能提前把当天卡作废或按不存在的收盘价结算。 */
function beforeShanghai(now: string, tradeDate: string, hhmm: string): boolean {
  return Date.parse(now) < Date.parse(`${tradeDate}T${hhmm}:00+08:00`)
}

function accountOf(accounts: PaperAccountRow[], kind: 'user' | 'shadow'): PaperAccountRow | null {
  return accounts.find((a) => a.kind === kind) ?? null
}

export interface AccountNavSnapshot {
  accountId: string
  cashCents: number
  frozenCashCents: number
  marketValueCents: number
  totalEquityCents: number
  /** 完全没有历史收盘，只能按缺价剔除。 */
  missingSymbols: string[]
  /** 用了早于 tradeDate 的收盘价（停牌或盘前），净值可用但不是当日质量。 */
  staleSymbols: string[]
  positions: ReturnType<typeof derivePositions>
}

/** 当日收盘缺失时回退最近可用价：否则停牌/盘前会把持仓市值整个抹掉，净值假跌。 */
export async function computePaperNav(accountId: string, tradeDate: string): Promise<AccountNavSnapshot> {
  const ledger = await loadPaperLedger(accountId)
  const positions = derivePositions({
    lots: ledger.lots,
    closes: ledger.closes,
    reservations: ledger.reservations,
    tradeDate,
  })
  const prices: Record<string, number | null> = {}
  const staleSymbols: string[] = []
  for (const p of positions) {
    if (p.totalQty === 0) continue
    const exact = await loadClosePriceCents(p.symbolCode, tradeDate)
    if (exact != null) {
      prices[p.symbolCode] = exact
      continue
    }
    prices[p.symbolCode] = await loadLatestClosePriceCents(p.symbolCode, tradeDate)
    if (prices[p.symbolCode] != null) staleSymbols.push(p.symbolCode)
  }
  const value = portfolioMarketValue(positions, prices)
  return {
    accountId,
    cashCents: ledger.cashTotalCents - ledger.frozenCashCents,
    frozenCashCents: ledger.frozenCashCents,
    marketValueCents: value.marketValueCents,
    totalEquityCents: ledger.cashTotalCents + value.marketValueCents,
    missingSymbols: value.missingSymbols,
    staleSymbols,
    positions,
  }
}

async function benchmarkReturn(input: {
  code: string
  tradeDate: string
}): Promise<{ code: string; closeCents: number | null; prevCloseCents: number | null; returnBp: number | null }> {
  const db = await getDb()
  const code = await resolvePaperBenchmarkCode(input.code, addCalendarDays(input.tradeDate, -30))
  const r = await db.execute({
    sql: `SELECT trade_date, close FROM market_bars
          WHERE code = ? AND trade_date <= ? AND adjust_type = 'raw'
          ORDER BY trade_date DESC LIMIT 2`,
    args: [code, input.tradeDate],
  })
  const closeCents = r.rows.length ? Math.round(num(r.rows[0].close) * 100) || null : null
  const prevCloseCents = r.rows.length > 1 ? Math.round(num(r.rows[1].close) * 100) || null : null
  const returnBp = closeCents != null && prevCloseCents != null && prevCloseCents > 0
    ? Math.round((closeCents - prevCloseCents) * 10_000 / prevCloseCents)
    : null
  return { code, closeCents, prevCloseCents, returnBp }
}

/** 16:30 估值：先写 NAV（append-only），再对账；对账通过才清除缺价禁买。 */
export async function runPaperNavAndReconcile(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperJobResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await activeExperiment(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  if (!(await isPaperTradingDay(tradeDate))) {
    return { skipped: true, reason: 'NOT_TRADING_DAY', tradeDate, detail: {} }
  }
  if (!(await hasMarketDataForDate(tradeDate))) {
    return { skipped: true, reason: 'NO_MARKET_DATA', tradeDate, detail: {} }
  }

  const accounts = await listPaperAccounts(experiment.id)
  const db = await getDb()

  async function recordDate(date: string): Promise<{ navs: Record<string, number>; reconciliations: Record<string, string> }> {
    const benchmark = await benchmarkReturn({ code: experiment.benchmarkCode, tradeDate: date })
    const reconciliations: Record<string, string> = {}
    const navs: Record<string, number> = {}
    for (const account of accounts) {
      if (account.status !== 'active') continue
      // 事后补写只能用“至今未再变动的账本”复算：之后有成交/分红就会把未来仓位算进历史净值。
      if (date !== tradeDate) {
        const changed = await db.execute({
          sql: 'SELECT 1 AS ok FROM paper_cash_entries WHERE account_id = ? AND trade_date > ? LIMIT 1',
          args: [account.id, date],
        })
        if (changed.rows.length) continue
      }
      const nav = await computePaperNav(account.id, date)
      // 周一的“昨天”是周日，没有 NAV 行；日收益必须对比上一交易日，否则每周都缺一天。
      const prevNav = await getPaperNavCents(account.id, await previousPaperTradingDate(date))
      const peakR = await db.execute({
        sql: 'SELECT MAX(total_equity_cents) AS peak FROM paper_nav WHERE account_id = ? AND trade_date <= ?',
        args: [account.id, date],
      })
      const peak = peakR.rows.length && peakR.rows[0].peak != null ? num(peakR.rows[0].peak) : null
      const dailyReturnBp = prevNav != null && prevNav > 0
        ? Math.round((nav.totalEquityCents - prevNav) * 10_000 / prevNav)
        : null
      const drawdownBp = peak != null && peak > 0
        ? Math.max(0, Math.round((peak - nav.totalEquityCents) * 10_000 / peak))
        : null
      await recordPaperNav({
        accountId: account.id,
        tradeDate: date,
        cashCents: nav.cashCents,
        frozenCashCents: nav.frozenCashCents,
        marketValueCents: nav.marketValueCents,
        totalEquityCents: nav.totalEquityCents,
        dailyReturnBp,
        drawdownBp,
        benchmark: { ...benchmark, basis: 'close' },
        quality: nav.missingSymbols.length || nav.staleSymbols.length ? 'warn' : 'pass',
        now,
      })
      navs[account.kind] = nav.totalEquityCents
      const reconciliation = await reconcilePaperAccount({ accountId: account.id, tradeDate: date, now })
      reconciliations[account.kind] = reconciliation.status
      // 补写旧日期不能当解除禁买的依据：只由当天对账通过来清除缺价状态。
      if (date === tradeDate && reconciliation.status === 'pass') {
        await clearPaperMissingPriceState({ accountId: account.id, now })
      }
    }
    return { navs, reconciliations }
  }

  // paper_nav 追加写且禁止 UPDATE：停过 16:30 的交易日必须补写，否则有效日与日收益永久缺行。
  // 从早到晚补，后一天的日收益才能接上前一天刚补的净值。
  const startDate = dateShanghai(experiment.startedAt ?? experiment.createdAt)
  const missingR = await db.execute({
    sql: `SELECT c.trade_date AS d FROM trading_calendar c
          WHERE c.is_open = 1 AND c.trade_date < ? AND c.trade_date >= ?
            AND NOT EXISTS (
              SELECT 1 FROM paper_nav n
              JOIN paper_accounts a ON a.id = n.account_id
              WHERE a.experiment_id = ? AND a.kind = 'user' AND n.trade_date = c.trade_date
            )
          ORDER BY c.trade_date DESC LIMIT 10`,
    args: [tradeDate, startDate, experiment.id],
  })
  const caughtUp: string[] = []
  for (const row of [...missingR.rows].reverse()) {
    const date = str(row.d)
    if (!(await hasMarketDataForDate(date))) continue
    await recordDate(date)
    caughtUp.push(date)
  }

  const current = await recordDate(tradeDate)
  const validDaysR = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM paper_nav n
          JOIN paper_accounts a ON a.id = n.account_id
          WHERE a.experiment_id = ? AND a.kind = 'user' AND n.trade_date <= ?
            AND n.quality = 'pass'`,
    args: [experiment.id, tradeDate],
  })
  await db.execute({
    sql: 'UPDATE paper_experiments SET valid_days = ?, updated_at = ? WHERE id = ?',
    args: [num(validDaysR.rows[0]?.n), now, experiment.id],
  })

  return {
    skipped: false,
    tradeDate,
    detail: { navs: current.navs, reconciliations: current.reconciliations, caughtUp: caughtUp.length ? caughtUp : undefined },
  }
}

async function loadHeldStops(experimentId: string): Promise<Map<string, number>> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT symbol_code, stop_price_cents FROM paper_decision_cards
          WHERE experiment_id = ? AND stop_price_cents IS NOT NULL
            AND status IN ('confirmed','executed')
          ORDER BY trade_date DESC, created_at DESC`,
    args: [experimentId],
  })
  const out = new Map<string, number>()
  for (const row of r.rows) {
    const symbol = str(row.symbol_code)
    if (!out.has(symbol)) out.set(symbol, num(row.stop_price_cents))
  }
  return out
}

export interface PaperCardsJobResult extends PaperJobResult {
  cardTradeDate: string
  cards: number
  observe: number
  warnings: string[]
}

/** 17:30 生成次日卡；16:20 的持仓扫描走同一路径，只处理已持仓标的。 */
export async function runPaperCards(input: {
  experimentId?: string | null
  barsDate?: string
  cardTradeDate?: string
  mode?: 'next_day' | 'position_scan'
  now?: string
  allowNetwork?: boolean
}): Promise<PaperCardsJobResult> {
  const barsDate = input.barsDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const mode = input.mode ?? 'next_day'
  const experiment = await activeExperiment(input.experimentId)
  const empty = (reason: string, cardTradeDate = barsDate): PaperCardsJobResult => ({
    skipped: true, reason, tradeDate: barsDate, cardTradeDate, cards: 0, observe: 0, warnings: [], detail: {},
  })
  if (!experiment) return empty('NO_ACTIVE_EXPERIMENT')
  if (!(await isPaperTradingDay(barsDate))) return empty('NOT_TRADING_DAY')
  if (!(await hasMarketDataForDate(barsDate))) return empty('NO_MARKET_DATA')

  await ensurePaperCalendar({
    fromDate: barsDate,
    allowNetwork: input.allowNetwork ?? process.env.NODE_ENV !== 'test',
  })
  const cardTradeDate = input.cardTradeDate ?? await nextPaperTradingDate(barsDate)
  if (cardTradeDate <= barsDate) return empty('CARD_DATE_NOT_FUTURE', cardTradeDate)

  const { policy } = await getPaperExperimentPolicy(experiment.id)
  const meta = await syncPaperSymbolMeta({ tradeDate: barsDate, experimentId: experiment.id })
  await syncPaperUniverse({ experimentId: experiment.id, now })
  const universe = await loadPaperUniverseFor(experiment.id, meta.symbols)
  if (!universe.length) return empty('EMPTY_UNIVERSE', cardTradeDate)

  const accounts = await listPaperAccounts(experiment.id)
  const user = accountOf(accounts, 'user')
  if (!user) return empty('NO_USER_ACCOUNT', cardTradeDate)
  const nav = await computePaperNav(user.id, barsDate)
  if (!(nav.totalEquityCents > 0)) return empty('NO_NAV', cardTradeDate)
  const holdings: HeldPositionInput[] = nav.positions
    .filter((p) => p.totalQty > 0)
    .map((p) => ({ symbolCode: p.symbolCode, totalQty: p.totalQty }))
  const stops = await loadHeldStops(experiment.id)
  for (const holding of holdings) holding.stopPriceCents = stops.get(holding.symbolCode) ?? null

  const bundle = await loadPaperFeatureBundle({
    tradeDate: barsDate,
    benchmarkCode: experiment.benchmarkCode,
    symbols: [...new Set([...universe, ...holdings.map((h) => h.symbolCode)])],
    positions: holdings,
    policy,
  })
  const warnings = [...meta.skipped.map((s) => `${s.symbolCode}: ${s.reason}`), ...bundle.warnings]
  const features = mode === 'position_scan'
    ? bundle.features.filter((f) => f.isHeld)
    : bundle.features

  // 持仓扫描与 17:30 全量生成各用一份快照，避免扫描覆盖次日卡的可追溯依据。
  const snapshotId = `snap-${experiment.id}-${cardTradeDate}-${mode}`
  const facts = {
    barsDate,
    cardTradeDate,
    mode,
    gate: bundle.gate,
    gateFacts: bundle.gateFacts,
    quality: bundle.quality,
    warnings,
  }
  const db = await getDb()
  await db.execute({
    sql: `INSERT OR IGNORE INTO paper_snapshots
      (id, experiment_id, as_of, trade_date, universe_json, dataset_version, source_manifest_json,
       quality_json, facts_json, content_hash, is_demo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    args: [
      snapshotId, experiment.id, now, cardTradeDate, JSON.stringify(features.map((f) => f.symbolCode)),
      `bars:${barsDate}`, JSON.stringify({ barsDate, benchmark: bundle.gateFacts.indexCode }),
      JSON.stringify({ quality: bundle.quality, warnings }), JSON.stringify(facts),
      crypto.createHash('sha256').update(stableStringify(facts)).digest('hex'), now,
    ],
  })

  let cards = 0
  let observe = 0
  for (const feature of features) {
    const existing = await db.execute({
      sql: `SELECT 1 AS ok FROM paper_decision_cards
            WHERE experiment_id = ? AND trade_date = ? AND symbol_code = ? LIMIT 1`,
      args: [experiment.id, cardTradeDate, feature.symbolCode],
    })
    if (existing.rows.length) continue
    const built = buildDecisionCard({
      policy,
      tradeDate: cardTradeDate,
      reviewDate: cardTradeDate,
      navCents: nav.totalEquityCents,
      marketGate: bundle.gate,
      features: feature,
    })
    const issues = validateDecisionCardDraft(built.draft, policy)
    if (issues.length) {
      warnings.push(`${feature.symbolCode}: 卡片校验失败 ${issues.map((i) => i.message).join('; ')}`)
      continue
    }
    const draft = built.draft
    const cardId = `card-${experiment.id}-${cardTradeDate}-${feature.symbolCode.replace('.', '')}`
    const inserted = await db.execute({
      sql: `INSERT OR IGNORE INTO paper_decision_cards
        (id, experiment_id, card_version, trade_date, symbol_code, snapshot_id, policy_version, status,
         stance, horizon, thesis, trigger_basis, trigger_op, trigger_price_cents,
         stop_price_cents, max_loss_cents, max_position_pct_bp,
         confidence_score, confidence_inputs_json, evidence_json, counter_evidence_json, invalidation,
         review_date, expires_at, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        cardId, experiment.id, cardTradeDate, feature.symbolCode, snapshotId, policy.version,
        draft.stance, draft.horizon, draft.thesis, draft.triggerBasis, draft.triggerOp,
        draft.triggerPriceCents, draft.stopPriceCents, draft.maxLossCents, draft.maxPositionPctBp,
        draft.confidenceScore, JSON.stringify(draft.confidenceInputsJson),
        JSON.stringify(draft.evidenceJson), JSON.stringify(draft.counterEvidenceJson),
        draft.invalidation, draft.reviewDate, draft.expiresAt, now, now,
      ],
    })
    if ((inserted.rowsAffected ?? 0) === 0) continue
    await db.execute({
      sql: `INSERT OR IGNORE INTO paper_card_events
        (card_id, seq, event_type, from_status, to_status, payload_json, created_at)
        VALUES (?, 1, 'created', NULL, 'active', ?, ?)`,
      args: [cardId, JSON.stringify({ mode, executable: built.executable, blocks: built.blocks }), now],
    })
    cards += 1
    if (draft.stance === 'observe' || draft.stance === 'caution') observe += 1
  }

  return {
    skipped: false,
    tradeDate: barsDate,
    cardTradeDate,
    cards,
    observe,
    warnings,
    detail: { snapshotId, quality: bundle.quality, gate: bundle.gate },
  }
}

async function loadPaperUniverseFor(experimentId: string, fallback: string[]): Promise<string[]> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT symbol_code FROM paper_universe
          WHERE experiment_id = ? AND removed_at IS NULL ORDER BY added_at, symbol_code`,
    args: [experimentId],
  })
  const listed = r.rows.map((row) => str(row.symbol_code)).filter(Boolean)
  return [...new Set([...listed, ...fallback])]
}

/** 08:30 盘前：只降级/作废，不新增买入；随后影子账户按同一规则自动执行触发卡。 */
export async function runPaperPreopen(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperJobResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await activeExperiment(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  if (!(await isPaperTradingDay(tradeDate))) {
    return { skipped: true, reason: 'NOT_TRADING_DAY', tradeDate, detail: {} }
  }
  // 盘前先补当日限价：结算与影子下单都依赖它；停牌状态在 16:20 有日线时才可判定。
  await ensurePaperMarketData({ experimentId: experiment.id, tradeDate, mode: 'preopen', now })
  const db = await getDb()
  const accounts = await listPaperAccounts(experiment.id)
  const user = accountOf(accounts, 'user')
  const riskState = user ? await getPaperRiskState(user.id) : null
  const blocked = Boolean(riskState?.killSwitch) || riskState?.dataQuality === 'fail'

  let invalidated = 0
  const cardsR = await db.execute({
    sql: `SELECT id, symbol_code, stance, status FROM paper_decision_cards
          WHERE experiment_id = ? AND trade_date = ? AND status IN ('active','triggered')`,
    args: [experiment.id, tradeDate],
  })
  for (const row of cardsR.rows) {
    const cardId = str(row.id)
    const symbolCode = str(row.symbol_code)
    const fromStatus = str(row.status)
    const context = await loadPaperSymbolContext(symbolCode, tradeDate)
    let reason: string | null = null
    if (!context.meta) reason = 'MISSING_META'
    else if (context.meta.delistDate) reason = 'DELISTED'
    else if (context.meta.isSt || context.status?.isSt) reason = 'ST'
    else if (context.status?.isSuspended) reason = 'SUSPENDED'
    else if (blocked && str(row.stance) !== 'observe') reason = 'RISK_STATE'
    if (!reason) continue
    const r = await db.execute({
      sql: `UPDATE paper_decision_cards SET status = 'invalidated', updated_at = ?
            WHERE id = ? AND status IN ('active','triggered')`,
      args: [now, cardId],
    })
    if ((r.rowsAffected ?? 0) > 0) {
      await db.execute({
        sql: `INSERT INTO paper_card_events
          (card_id, seq, event_type, from_status, to_status, payload_json, created_at)
          VALUES (?, (SELECT COALESCE(MAX(seq),0)+1 FROM paper_card_events WHERE card_id = ?),
            'invalidated', ?, 'invalidated', ?, ?)`,
        args: [cardId, cardId, fromStatus, JSON.stringify({ reason }), now],
      })
      invalidated += 1
    }
  }

  const shadow = await runPaperShadowExecution({ experimentId: experiment.id, tradeDate, now })
  if (shadow.skipped && shadow.reason === 'PAST_CUTOFF') {
    const user = accountOf(await listPaperAccounts(experiment.id), 'user')
    const db = await getDb()
    const existing = user
      ? await db.execute({
        sql: `SELECT 1 AS ok FROM paper_risk_events
              WHERE account_id = ? AND rule = 'shadow_cutoff_missed' AND created_at LIKE ? LIMIT 1`,
        args: [user.id, `${tradeDate}%`],
      })
      : { rows: [] }
    if (user && !existing.rows.length) {
      // 错过 09:15 不能再补造成交，但必须让用户看到“当天没有系统判断”。
      await recordPaperRiskEvent(db, {
        accountId: user.id,
        rule: 'shadow_cutoff_missed',
        severity: 'warn',
        action: 'skip',
        message: `${tradeDate} 09:15 前未生成影子委托，当日系统判断缺失`,
        dataQuality: 'warn',
        createdAt: now,
      })
    }
  }
  return {
    skipped: false,
    tradeDate,
    detail: { invalidated, shadow: shadow.detail, shadowSkipped: shadow.reason ?? null },
  }
}

/** 影子账户：候选买入卡全部按同规则下单；不推进卡状态，用户仍可自行确认。 */
export async function runPaperShadowExecution(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperJobResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await activeExperiment(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  // 补跑不得在 09:15 之后补造影子成交。
  if (Date.parse(now) >= Date.parse(`${tradeDate}T09:15:00+08:00`)) {
    return { skipped: true, reason: 'PAST_CUTOFF', tradeDate, detail: {} }
  }
  const accounts = await listPaperAccounts(experiment.id)
  const shadow = accountOf(accounts, 'shadow')
  if (!shadow || shadow.status !== 'active') {
    return { skipped: true, reason: 'NO_SHADOW_ACCOUNT', tradeDate, detail: {} }
  }
  const { policy } = await getPaperExperimentPolicy(experiment.id)
  const db = await getDb()
  const cardsR = await db.execute({
    sql: `SELECT * FROM paper_decision_cards
          WHERE experiment_id = ? AND trade_date = ? AND status = 'active'
            AND stance = 'candidate'
          ORDER BY confidence_score DESC, id`,
    args: [experiment.id, tradeDate],
  })
  const nav = await computePaperNav(shadow.id, tradeDate)
  let confirmed = 0
  let skipped = 0
  let blocked = 0
  for (const row of cardsR.rows) {
    const cardId = str(row.id)
    const symbolCode = str(row.symbol_code)
    const triggerPriceCents = num(row.trigger_price_cents)
    const stopPriceCents = num(row.stop_price_cents)
    if (triggerPriceCents <= 0 || stopPriceCents <= 0) {
      skipped += 1
      continue
    }
    const context = await loadPaperSymbolContext(symbolCode, tradeDate)
    if (!context.meta) {
      skipped += 1
      continue
    }
    const sized = sizePositionCents({
      policy,
      navCents: nav.totalEquityCents,
      referencePriceCents: triggerPriceCents,
      stopPriceCents,
      board: context.meta.board,
    })
    if (sized.qty <= 0) {
      skipped += 1
      continue
    }
    const fees = calcFees('buy', sized.qty, triggerPriceCents, triggerPriceCents, policy.fees)
    const reservations = [{ kind: 'cash' as const, amountCents: sized.grossCents + fees.totalFeesCents }]
    const request = {
      accountId: shadow.id,
      actor: 'shadow' as const,
      cardId,
      cardVersion: num(row.card_version),
      symbolCode,
      side: 'buy' as const,
      orderType: 'open_price_condition' as const,
      qty: sized.qty,
      conditionOp: (str(row.trigger_op) === 'gte' ? 'gte' : 'lte') as 'lte' | 'gte',
      triggerPriceCents,
      clientRequestId: `shadow:${cardId}`,
      idempotencyKey: `shadow:${cardId}`,
      requestHash: paperRequestHash({ cardId, qty: sized.qty, tradeDate }),
      targetTradeDate: tradeDate,
      reservations,
      confirmedAt: now,
      mutateCard: false,
    }
    try {
      const result = await confirmPaperOrder(request)
      if (!result.replayed) confirmed += 1
      else skipped += 1
    } catch (err) {
      if (err instanceof PaperRepoError) {
        blocked += 1
        await recordPaperRiskEvent(db, {
          accountId: shadow.id,
          rule: 'shadow_execute',
          severity: 'warn',
          action: 'skip',
          message: `影子执行被拒绝：${err.message}`,
          cardId,
          dataQuality: 'pass',
          createdAt: now,
        })
        continue
      }
      throw err
    }
  }
  return { skipped: false, tradeDate, detail: { confirmed, skipped, blocked } }
}

/** 09:15 截止：未确认的卡作废，已确认委托冻结到收盘结算。 */
export async function runPaperCutoff(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperJobResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await experimentForOperations(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  if (!(await isPaperTradingDay(tradeDate))) {
    return { skipped: true, reason: 'NOT_TRADING_DAY', tradeDate, detail: {} }
  }
  if (beforeShanghai(now, tradeDate, '09:15')) {
    return { skipped: true, reason: 'BEFORE_CUTOFF', tradeDate, detail: {} }
  }
  const frozen = await freezePaperOrders({ experimentId: experiment.id, tradeDate, at: now })
  const db = await getDb()
  const expiredR = await db.execute({
    sql: `UPDATE paper_decision_cards SET status = 'expired', updated_at = ?
          WHERE experiment_id = ? AND trade_date = ? AND status IN ('active','triggered')`,
    args: [now, experiment.id, tradeDate],
  })
  const expired = expiredR.rowsAffected ?? 0
  // 节假日/停摆留下的旧卡一并收口，避免恢复后还能确认过期的买入。
  const staleR = await db.execute({
    sql: `UPDATE paper_decision_cards SET status = 'expired', updated_at = ?
          WHERE experiment_id = ? AND trade_date < ? AND status IN ('active','triggered')`,
    args: [now, experiment.id, tradeDate],
  })
  if ((staleR.rowsAffected ?? 0) > 0) {
    await db.execute({
      sql: `INSERT INTO paper_card_events (card_id, seq, event_type, from_status, to_status, payload_json, created_at)
            SELECT id, (SELECT COALESCE(MAX(e.seq),0)+1 FROM paper_card_events e WHERE e.card_id = c.id),
              'cutoff', 'active', 'expired', '{"reason":"STALE"}', ?
            FROM paper_decision_cards c
            WHERE c.experiment_id = ? AND c.trade_date < ? AND c.status = 'expired'
              AND NOT EXISTS (
                SELECT 1 FROM paper_card_events e2
                WHERE e2.card_id = c.id AND e2.event_type = 'cutoff'
              )`,
      args: [now, experiment.id, tradeDate],
    })
  }
  if (expired > 0) {
    await db.execute({
      sql: `INSERT INTO paper_card_events (card_id, seq, event_type, from_status, to_status, payload_json, created_at)
            SELECT id, (SELECT COALESCE(MAX(e.seq),0)+1 FROM paper_card_events e WHERE e.card_id = c.id),
              'cutoff', 'active', 'expired', '{"reason":"TOO_LATE"}', ?
            FROM paper_decision_cards c
            WHERE c.experiment_id = ? AND c.trade_date = ? AND c.status = 'expired'
              AND NOT EXISTS (
                SELECT 1 FROM paper_card_events e2
                WHERE e2.card_id = c.id AND e2.event_type = 'cutoff'
              )`,
      args: [now, experiment.id, tradeDate],
    })
  }
  return { skipped: false, tradeDate, detail: { frozen, expired } }
}

/** 16:20 结算：只按官方日线开盘价成交；当日无行情（休市/未入库）不结算。 */
export async function runPaperSettle(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperJobResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await experimentForOperations(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  if (!(await isPaperTradingDay(tradeDate))) {
    return { skipped: true, reason: 'NOT_TRADING_DAY', tradeDate, detail: {} }
  }
  if (beforeShanghai(now, tradeDate, '16:20')) {
    return { skipped: true, reason: 'BEFORE_SETTLE', tradeDate, detail: {} }
  }
  if (!(await hasMarketDataForDate(tradeDate))) {
    const user = accountOf(await listPaperAccounts(experiment.id), 'user')
    if (user) {
      const db = await getDb()
      const existing = await db.execute({
        sql: `SELECT 1 AS ok FROM paper_risk_events
              WHERE account_id = ? AND rule = 'data_ingest' AND created_at LIKE ? LIMIT 1`,
        args: [user.id, `${tradeDate}%`],
      })
      if (!existing.rows.length) {
        await recordPaperRiskEvent(db, {
          accountId: user.id,
          rule: 'data_ingest',
          severity: 'warn',
          action: 'skip_settlement',
          message: `${tradeDate} 行情未入库，暂不结算`,
          dataQuality: 'warn',
          createdAt: now,
        })
      }
    }
    return { skipped: true, reason: 'NO_MARKET_DATA', tradeDate, detail: {} }
  }
  await ensurePaperMarketData({ experimentId: experiment.id, tradeDate, mode: 'settle', now })
  await freezePaperOrders({ experimentId: experiment.id, tradeDate, at: now })
  const result = await settlePaperOrders({ experimentId: experiment.id, tradeDate, settledAt: now })
  const outcomes: Record<string, number> = {}
  for (const item of result.results) {
    const key = item.decision?.outcome ?? item.reason ?? 'unknown'
    outcomes[key] = (outcomes[key] ?? 0) + 1
  }
  // 进程跨过 16:20 停机时前一日委托会永久滞留：目标日行情齐全就按原日开盘价补结算。
  const db = await getDb()
  const staleR = await db.execute({
    sql: `SELECT DISTINCT target_trade_date AS d FROM paper_orders
          WHERE experiment_id = ? AND target_trade_date < ?
            AND status IN ('confirmed','settlement_pending')
          ORDER BY target_trade_date ASC LIMIT 20`,
    args: [experiment.id, tradeDate],
  })
  // 行情永久缺失的目标日不能一直挂着：留给迟到数据三个交易日，之后按 expired 收口并释放冻结。
  const expireBefore = await addPaperTradingDays(tradeDate, -3)
  const caughtUp: Record<string, number> = {}
  for (const row of staleR.rows) {
    const staleDate = str(row.d)
    const trading = await isPaperTradingDay(staleDate)
    const hasData = trading && await hasMarketDataForDate(staleDate)
    if (hasData) {
      await ensurePaperMarketData({ experimentId: experiment.id, tradeDate: staleDate, mode: 'settle', now })
      const stale = await settlePaperOrders({
        experimentId: experiment.id,
        tradeDate: staleDate,
        settledAt: now,
      })
      if (stale.settled || stale.failed) caughtUp[staleDate] = stale.settled
      continue
    }
    if (trading && staleDate >= expireBefore) continue
    const expired = await settlePaperOrders({
      experimentId: experiment.id,
      tradeDate: staleDate,
      settledAt: now,
    })
    if (expired.settled || expired.failed) caughtUp[staleDate] = expired.settled
  }
  return {
    skipped: false,
    tradeDate,
    detail: {
      settled: result.settled,
      failed: result.failed,
      skipped: result.skipped,
      outcomes,
      caughtUp: Object.keys(caughtUp).length ? caughtUp : undefined,
    },
  }
}

/** 16:20 持仓扫描：只对已持仓标的生成证伪/退出卡，抓 17:30 之前的风险。 */
export async function runPaperPositionScan(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
  allowNetwork?: boolean
}): Promise<PaperCardsJobResult> {
  return runPaperCards({
    experimentId: input.experimentId,
    barsDate: input.tradeDate,
    now: input.now,
    allowNetwork: input.allowNetwork,
    mode: 'position_scan',
  })
}

export interface PaperReviewResult extends PaperJobResult {
  reviewId?: string
  executionRateBp?: number | null
}

interface DailyFacts {
  tradeDate: string
  benchmark: { code: string; returnBp: number | null }
  accounts: Record<string, { navCents: number | null; prevNavCents: number | null; returnBp: number | null }>
  cards: { total: number; candidates: number; invalidated: number }
  orders: Record<string, number>
  fills: Array<{ symbolCode: string; side: string; qty: number; priceCents: number; feesCents: number }>
  executionRateBp: number | null
  deviations: Array<{ cardId: string; symbolCode: string; reason: string; detail?: string }>
  reconciliations: Record<string, string>
  riskEvents: Array<{ rule: string; message: string; severity: string }>
  positions: Array<{ symbolCode: string; totalQty: number; marketValueCents: number; weightBp: number }>
  concentration: { top3WeightBp: number; industries: Array<{ industry: string; weightBp: number }> }
  nextTradeDate: string
}

async function loadDailyFacts(experiment: PaperExperimentRow, tradeDate: string): Promise<DailyFacts> {
  const db = await getDb()
  const accounts = await listPaperAccounts(experiment.id)
  const benchmark = await benchmarkReturn({ code: experiment.benchmarkCode, tradeDate })
  const user = accountOf(accounts, 'user')
  const accountFacts: DailyFacts['accounts'] = {}
  const reconciliations: Record<string, string> = {}
  for (const account of accounts) {
    const navR = await db.execute({
      sql: `SELECT trade_date, total_equity_cents FROM paper_nav
            WHERE account_id = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 2`,
      args: [account.id, tradeDate],
    })
    const navCents = navR.rows.length ? num(navR.rows[0].total_equity_cents) : null
    const prevNavCents = navR.rows.length > 1 ? num(navR.rows[1].total_equity_cents) : null
    accountFacts[account.kind] = {
      navCents,
      prevNavCents,
      returnBp: navCents != null && prevNavCents != null && prevNavCents > 0
        ? Math.round((navCents - prevNavCents) * 10_000 / prevNavCents)
        : null,
    }
    const reconR = await db.execute({
      sql: 'SELECT status FROM paper_reconciliations WHERE account_id = ? AND trade_date = ?',
      args: [account.id, tradeDate],
    })
    if (reconR.rows.length) reconciliations[account.kind] = str(reconR.rows[0].status)
  }

  const cardsR = await db.execute({
    sql: `SELECT id, symbol_code, stance, status FROM paper_decision_cards
          WHERE experiment_id = ? AND trade_date = ?`,
    args: [experiment.id, tradeDate],
  })
  const cards = { total: cardsR.rows.length, candidates: 0, invalidated: 0 }
  for (const row of cardsR.rows) {
    if (str(row.stance) === 'candidate') cards.candidates += 1
    if (str(row.status) === 'invalidated') cards.invalidated += 1
  }

  const ordersR = await db.execute({
    sql: `SELECT id, card_id, symbol_code, status, reject_code, off_plan_reason, actor
          FROM paper_orders WHERE experiment_id = ? AND target_trade_date = ?`,
    args: [experiment.id, tradeDate],
  })
  // 触发卡 = 至少有一笔非「未触发」委托的候选卡；连影子都没下单的，保守按已触发计。
  const statusesByCard = new Map<string, string[]>()
  for (const row of ordersR.rows) {
    const cardId = str(row.card_id)
    if (!cardId) continue
    const list = statusesByCard.get(cardId) ?? []
    list.push(str(row.status))
    statusesByCard.set(cardId, list)
  }

  const orders: Record<string, number> = {}
  const deviations: DailyFacts['deviations'] = []
  const userOrders = ordersR.rows.filter((row) => str(row.actor) === 'user')
  for (const row of userOrders) {
    const status = str(row.status)
    orders[status] = (orders[status] ?? 0) + 1
    if (row.off_plan_reason) {
      deviations.push({
        cardId: str(row.card_id), symbolCode: str(row.symbol_code),
        reason: 'off_plan', detail: str(row.off_plan_reason),
      })
    } else if (status === 'rejected' || status === 'expired') {
      const code = str(row.reject_code)
      deviations.push({
        cardId: str(row.card_id), symbolCode: str(row.symbol_code),
        reason: /RISK_/.test(code) ? 'risk_blocked' : 'data_blocked', detail: code,
      })
    }
  }
  const confirmedCardIds = new Set(userOrders.map((row) => str(row.card_id)).filter(Boolean))
  let triggeredCandidates = 0
  for (const row of cardsR.rows) {
    if (str(row.stance) !== 'candidate') continue
    const cardId = str(row.id)
    const statuses = statusesByCard.get(cardId)
    const triggered = !statuses || statuses.some((status) => status !== 'trigger_not_met')
    if (triggered) triggeredCandidates += 1
    if (confirmedCardIds.has(cardId)) continue
    if (str(row.status) === 'invalidated') {
      deviations.push({ cardId, symbolCode: str(row.symbol_code), reason: 'data_blocked', detail: 'card_invalidated' })
    } else if (triggered) {
      deviations.push({ cardId, symbolCode: str(row.symbol_code), reason: 'not_confirmed' })
    }
  }
  const filledCards = new Set(userOrders
    .filter((row) => str(row.status) === 'filled')
    .map((row) => str(row.card_id)).filter(Boolean))
  const executionRateBp = triggeredCandidates > 0
    ? Math.round(filledCards.size * 10_000 / triggeredCandidates)
    : null

  const fillsR = await db.execute({
    sql: `SELECT f.symbol_code, f.side, f.qty, f.price_cents, f.total_fees_cents
          FROM paper_fills f JOIN paper_orders o ON o.id = f.order_id
          WHERE o.experiment_id = ? AND f.trade_date = ? AND o.actor = 'user'`,
    args: [experiment.id, tradeDate],
  })
  const fills = fillsR.rows.map((row) => ({
    symbolCode: str(row.symbol_code),
    side: str(row.side),
    qty: num(row.qty),
    priceCents: num(row.price_cents),
    feesCents: num(row.total_fees_cents),
  }))

  const riskR = await db.execute({
    sql: `SELECT rule, severity, message FROM paper_risk_events
          WHERE account_id IN (SELECT id FROM paper_accounts WHERE experiment_id = ?)
            AND created_at LIKE ? ORDER BY created_at DESC LIMIT 20`,
    args: [experiment.id, `${tradeDate}%`],
  })
  const riskEvents = riskR.rows.map((row) => ({
    rule: str(row.rule), severity: str(row.severity), message: str(row.message),
  }))

  const positions: DailyFacts['positions'] = []
  let concentration: DailyFacts['concentration'] = { top3WeightBp: 0, industries: [] }
  if (user) {
    const nav = await computePaperNav(user.id, tradeDate)
    const byIndustry = new Map<string, number>()
    for (const p of nav.positions) {
      if (p.totalQty === 0) continue
      const price = await loadClosePriceCents(p.symbolCode, tradeDate)
      const value = price != null ? price * p.totalQty : 0
      positions.push({
        symbolCode: p.symbolCode,
        totalQty: p.totalQty,
        marketValueCents: value,
        weightBp: nav.totalEquityCents > 0 ? Math.round(value * 10_000 / nav.totalEquityCents) : 0,
      })
      const context = await loadPaperSymbolContext(p.symbolCode, tradeDate)
      const industry = context.meta?.industryName ?? '未分类'
      byIndustry.set(industry, (byIndustry.get(industry) ?? 0) + value)
    }
    positions.sort((a, b) => b.marketValueCents - a.marketValueCents)
    const top3WeightBp = positions
      .map((p) => p.weightBp)
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((sum, v) => sum + v, 0)
    const industries = [...byIndustry.entries()]
      .map(([industry, value]) => ({
        industry,
        weightBp: nav.totalEquityCents > 0 ? Math.round(value * 10_000 / nav.totalEquityCents) : 0,
      }))
      .sort((a, b) => b.weightBp - a.weightBp)
    concentration = { top3WeightBp, industries }
  }

  return {
    tradeDate,
    benchmark: { code: benchmark.code, returnBp: benchmark.returnBp },
    accounts: accountFacts,
    cards,
    orders,
    fills,
    executionRateBp,
    deviations,
    reconciliations,
    riskEvents,
    positions,
    concentration,
    nextTradeDate: await nextPaperTradingDate(tradeDate),
  }
}

function bpText(bp: number | null): string {
  if (bp == null) return '不可用'
  const sign = bp > 0 ? '+' : ''
  return `${sign}${(bp / 100).toFixed(2)}%`
}

function buildDailyNarrative(facts: DailyFacts): string {
  const user = facts.accounts.user
  const shadow = facts.accounts.shadow
  const lines: string[] = []
  lines.push(`${facts.tradeDate} 收盘复盘。`)
  lines.push(`主账户净值 ${user?.navCents == null ? '不可用' : `¥${(user.navCents / 100).toFixed(2)}`}，`
    + `日变动 ${bpText(user?.returnBp ?? null)}；影子账户净值 `
    + `${shadow?.navCents == null ? '不可用' : `¥${(shadow.navCents / 100).toFixed(2)}`}，`
    + `日变动 ${bpText(shadow?.returnBp ?? null)}；基准 ${facts.benchmark.code} ${bpText(facts.benchmark.returnBp)}。`)
  lines.push(`决策卡 ${facts.cards.total} 张，候选买入 ${facts.cards.candidates} 张；`
    + `用户委托 ${Object.values(facts.orders).reduce((sum, n) => sum + n, 0)} 笔，成交 ${facts.fills.length} 笔；`
    + `计划执行率 ${facts.executionRateBp == null ? '不可用' : `${(facts.executionRateBp / 100).toFixed(1)}%`}。`)
  if (facts.fills.length) {
    lines.push('成交明细：' + facts.fills.map((f) =>
      `${f.symbolCode} ${f.side === 'buy' ? '买' : '卖'} ${f.qty} 股 @ ¥${(f.priceCents / 100).toFixed(2)}，费用 ¥${(f.feesCents / 100).toFixed(2)}`,
    ).join('；') + '。')
  }
  const deviationCounts = facts.deviations.reduce<Record<string, number>>((acc, d) => {
    acc[d.reason] = (acc[d.reason] ?? 0) + 1
    return acc
  }, {})
  lines.push('偏离原因：' + (Object.keys(deviationCounts).length
    ? Object.entries(deviationCounts).map(([reason, n]) => `${reason} ${n}`).join('，')
    : '无') + '。')
  lines.push('对账：' + (Object.keys(facts.reconciliations).length
    ? Object.entries(facts.reconciliations).map(([kind, status]) => `${kind === 'user' ? '主账户' : '影子'} ${status}`).join('；')
    : '今日未生成对账记录') + '。')
  if (facts.riskEvents.length) {
    lines.push('风险事件：' + facts.riskEvents.slice(0, 5).map((e) => `[${e.severity}] ${e.message}`).join('；') + '。')
  }
  if (facts.positions.length) {
    lines.push(`持仓 ${facts.positions.length} 只，前三大权重合计 ${(facts.concentration.top3WeightBp / 100).toFixed(1)}%；`
      + '行业分布：' + facts.concentration.industries.slice(0, 5)
        .map((i) => `${i.industry} ${(i.weightBp / 100).toFixed(1)}%`).join('，') + '。')
  } else {
    lines.push('当前无持仓。')
  }
  lines.push(`明日（${facts.nextTradeDate}）待办：复核到期卡与触发条件；缺价或数据质量问题需先修复。`)
  return lines.join('\n')
}

async function upsertReview(input: {
  experimentId: string
  kind: 'daily' | 'weekly'
  periodStart: string
  periodEnd: string
  facts: unknown
  narrative: string
  actualNavCents: number | null
  shadowNavCents: number | null
  executionRateBp: number | null
  deviations: unknown
  now: string
}): Promise<string> {
  const db = await getDb()
  const id = `review-${input.experimentId}-${input.kind}-${input.periodEnd}`
  await db.execute({
    sql: `INSERT INTO paper_reviews
      (id, experiment_id, kind, period_start, period_end, facts_json, narrative,
       actual_nav_cents, shadow_nav_cents, execution_rate_bp, deviations_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experiment_id, kind, period_end) DO UPDATE SET
        facts_json = excluded.facts_json, narrative = excluded.narrative,
        actual_nav_cents = excluded.actual_nav_cents, shadow_nav_cents = excluded.shadow_nav_cents,
        execution_rate_bp = excluded.execution_rate_bp, deviations_json = excluded.deviations_json`,
    args: [
      id, input.experimentId, input.kind, input.periodStart, input.periodEnd,
      JSON.stringify(input.facts), input.narrative, input.actualNavCents, input.shadowNavCents,
      input.executionRateBp, JSON.stringify(input.deviations), input.now,
    ],
  })
  return id
}

/** 17:00 当日复盘：事实叙述，不做“做得好/不好”的评价。 */
export async function runPaperDailyReview(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperReviewResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await activeExperiment(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  if (!(await isPaperTradingDay(tradeDate))) {
    return { skipped: true, reason: 'NOT_TRADING_DAY', tradeDate, detail: {} }
  }
  const facts = await loadDailyFacts(experiment, tradeDate)
  const narrative = buildDailyNarrative(facts)
  const reviewId = await upsertReview({
    experimentId: experiment.id,
    kind: 'daily',
    periodStart: tradeDate,
    periodEnd: tradeDate,
    facts,
    narrative,
    actualNavCents: facts.accounts.user?.navCents ?? null,
    shadowNavCents: facts.accounts.shadow?.navCents ?? null,
    executionRateBp: facts.executionRateBp,
    deviations: facts.deviations,
    now,
  })
  return {
    skipped: false,
    tradeDate,
    reviewId,
    executionRateBp: facts.executionRateBp,
    detail: { narrative },
  }
}

/** 周六 10:00 周复盘：本周净值/超额/回撤/成交/费用/执行率；错过周六则在之后每日补跑同一周。 */
export async function runPaperWeeklyReview(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperReviewResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await activeExperiment(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  const periodEnd = weeklyPeriodEnd(tradeDate)
  const periodStart = addCalendarDays(periodEnd, -5)
  const startedAt = Date.parse(experiment.startedAt ?? experiment.createdAt)
  if (Number.isFinite(startedAt) && startedAt > Date.parse(`${periodEnd}T23:59:59+08:00`)) {
    // 实验开始前的一周没有净值可复盘，补跑不应留下空记录。
    return { skipped: true, reason: 'PERIOD_BEFORE_START', tradeDate, detail: {} }
  }
  const db = await getDb()
  const accounts = await listPaperAccounts(experiment.id)
  const summary: Record<string, unknown> = {}
  for (const account of accounts) {
    const r = await db.execute({
      sql: `SELECT trade_date, total_equity_cents, daily_return_bp, drawdown_bp
            FROM paper_nav WHERE account_id = ? AND trade_date BETWEEN ? AND ?
            ORDER BY trade_date ASC`,
      args: [account.id, periodStart, periodEnd],
    })
    const first = r.rows[0] ? num(r.rows[0].total_equity_cents) : null
    const last = r.rows.length ? num(r.rows[r.rows.length - 1].total_equity_cents) : null
    const returnBp = first != null && last != null && first > 0
      ? Math.round((last - first) * 10_000 / first)
      : null
    const maxDrawdownBp = r.rows.reduce((max, row) => Math.max(max, num(row.drawdown_bp)), 0)
    const fillsR = await db.execute({
      sql: `SELECT COUNT(*) AS n, COALESCE(SUM(total_fees_cents),0) AS fees
            FROM paper_fills WHERE account_id = ? AND trade_date BETWEEN ? AND ?`,
      args: [account.id, periodStart, periodEnd],
    })
    summary[account.kind] = {
      startNavCents: first,
      endNavCents: last,
      returnBp,
      maxDrawdownBp,
      fills: num(fillsR.rows[0]?.n),
      feesCents: num(fillsR.rows[0]?.fees),
    }
  }
  const benchmarkCode = await resolvePaperBenchmarkCode(experiment.benchmarkCode, periodStart)
  const benchmarkR = await db.execute({
    sql: `SELECT trade_date, close FROM market_bars
          WHERE code = ? AND trade_date BETWEEN ? AND ? AND adjust_type = 'raw'
          ORDER BY trade_date ASC`,
    args: [benchmarkCode, periodStart, periodEnd],
  })
  const firstClose = benchmarkR.rows[0] ? num(benchmarkR.rows[0].close) : null
  const lastClose = benchmarkR.rows.length ? num(benchmarkR.rows[benchmarkR.rows.length - 1].close) : null
  const benchmarkReturnBp = firstClose != null && lastClose != null && firstClose > 0
    ? Math.round((lastClose - firstClose) * 10_000 / firstClose)
    : null

  const dailyR = await db.execute({
    sql: `SELECT execution_rate_bp FROM paper_reviews
          WHERE experiment_id = ? AND kind = 'daily' AND period_end BETWEEN ? AND ?`,
    args: [experiment.id, periodStart, periodEnd],
  })
  // 0% 也是有效观测；只有 NULL（当天没有触发卡）不参与平均。
  const rates = dailyR.rows
    .map((row) => (row.execution_rate_bp == null ? null : num(row.execution_rate_bp)))
    .filter((n): n is number => n != null)
  const executionRateBp = rates.length
    ? Math.round(rates.reduce((sum, n) => sum + n, 0) / rates.length)
    : null

  const narrative = [
    `本周复盘（${periodStart} 至 ${periodEnd}）。`,
    `主账户收益 ${bpText((summary.user as { returnBp: number | null } | undefined)?.returnBp ?? null)}，`
      + `影子账户收益 ${bpText((summary.shadow as { returnBp: number | null } | undefined)?.returnBp ?? null)}，`
      + `基准 ${benchmarkCode} ${bpText(benchmarkReturnBp)}。`,
    `成交 ${((summary.user as { fills: number } | undefined)?.fills ?? 0) + ((summary.shadow as { fills: number } | undefined)?.fills ?? 0)} 笔，`
      + `费用合计 ¥${((((summary.user as { feesCents: number } | undefined)?.feesCents ?? 0)
        + ((summary.shadow as { feesCents: number } | undefined)?.feesCents ?? 0)) / 100).toFixed(2)}。`,
    `计划执行率 ${executionRateBp == null ? '不可用' : `${(executionRateBp / 100).toFixed(1)}%`}；`
      + '低于 80% 时先看偏离原因，再看收益。',
    '下周关注：候选池变化、行业强弱与数据质量修复；不做主观评价。',
  ].join('\n')

  const reviewId = await upsertReview({
    experimentId: experiment.id,
    kind: 'weekly',
    periodStart,
    periodEnd,
    facts: { summary, benchmarkReturnBp },
    narrative,
    actualNavCents: (summary.user as { endNavCents: number | null } | undefined)?.endNavCents ?? null,
    shadowNavCents: (summary.shadow as { endNavCents: number | null } | undefined)?.endNavCents ?? null,
    executionRateBp,
    deviations: [],
    now,
  })
  return { skipped: false, tradeDate, reviewId, executionRateBp, detail: { summary, benchmarkReturnBp } }
}

interface OutcomeCell {
  cardId: string
  horizonDays: number
  returnBp: number | null
  benchmarkReturnBp: number | null
  alphaBp: number | null
  maxAdverseBp: number | null
  hit: number | null
  reasonClass: string | null
  invalidationHit: number | null
  notes: string
  evaluateDate: string
  dataQuality: DataQuality
}

/** 17:15 到期评估：5/20/60 个交易日，触发价/决策价入场，基准对照。 */
export async function runPaperEvaluateOutcomes(input: {
  experimentId?: string | null
  tradeDate?: string
  now?: string
}): Promise<PaperJobResult> {
  const tradeDate = input.tradeDate ?? todayShanghai()
  const now = input.now ?? new Date().toISOString()
  const experiment = await activeExperiment(input.experimentId)
  if (!experiment) return { skipped: true, reason: 'NO_ACTIVE_EXPERIMENT', tradeDate, detail: {} }
  const db = await getDb()
  // 最长 60 日观察窗 + 行情入库延迟留 30 日余量；缺当日行情时下次还能重新评估。
  const lookback = await addPaperTradingDays(tradeDate, -90)
  const cardsR = await db.execute({
    sql: `SELECT id, trade_date, symbol_code, status, stance, trigger_op, trigger_price_cents,
                 stop_price_cents, horizon
          FROM paper_decision_cards
          WHERE experiment_id = ? AND trade_date >= ? AND stance = 'candidate'
          ORDER BY trade_date ASC`,
    args: [experiment.id, lookback],
  })
  const benchmark = await resolvePaperBenchmarkCode(experiment.benchmarkCode, lookback)
  const horizons: Array<5 | 20 | 60> = [5, 20, 60]
  let evaluated = 0
  for (const card of cardsR.rows) {
    const cardId = str(card.id)
    const cardDate = str(card.trade_date)
    for (const horizon of horizons) {
      const evaluateDate = await addPaperTradingDays(cardDate, horizon)
      if (evaluateDate > tradeDate) continue
      const existingR = await db.execute({
        sql: `SELECT 1 AS ok FROM paper_decision_outcomes WHERE card_id = ? AND horizon_days = ?`,
        args: [cardId, horizon],
      })
      if (existingR.rows.length) continue
      const cell = await buildOutcomeCell({
        cardId,
        cardDate,
        symbolCode: str(card.symbol_code),
        horizon,
        evaluateDate,
        triggerOp: str(card.trigger_op),
        triggerPriceCents: num(card.trigger_price_cents),
        stopPriceCents: num(card.stop_price_cents),
        status: str(card.status),
        benchmark,
      })
      if (!cell) continue
      await db.execute({
        sql: `INSERT INTO paper_decision_outcomes
          (id, card_id, evaluate_date, horizon_days, return_bp, benchmark_return_bp, alpha_bp,
           max_adverse_bp, hit, reason_class, invalidation_hit, notes, data_quality, evaluated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(card_id, horizon_days) DO NOTHING`,
        args: [
          `outcome-${cardId}-${horizon}`, cardId, cell.evaluateDate, cell.horizonDays,
          cell.returnBp, cell.benchmarkReturnBp, cell.alphaBp, cell.maxAdverseBp, cell.hit,
          cell.reasonClass, cell.invalidationHit, cell.notes, cell.dataQuality, now,
        ],
      })
      evaluated += 1
    }
  }
  return { skipped: false, tradeDate, detail: { evaluated } }
}

async function buildOutcomeCell(input: {
  cardId: string
  cardDate: string
  symbolCode: string
  horizon: number
  evaluateDate: string
  triggerOp: string
  triggerPriceCents: number
  stopPriceCents: number
  status: string
  benchmark: string
}): Promise<OutcomeCell | null> {
  const db = await getDb()
  const entryR = await db.execute({
    sql: `SELECT trade_date, open, close, low FROM market_bars
          WHERE code = ? AND trade_date >= ? AND trade_date <= ? AND adjust_type = 'raw'
          ORDER BY trade_date ASC`,
    args: [input.symbolCode, input.cardDate, input.evaluateDate],
  })
  if (!entryR.rows.length) return null
  const bars = entryR.rows
  const entryBar = bars[0]
  // 卡当日没复牌（停牌缺行）或评估日行情未入库时先不写，宁可下次重评也不固化错口径。
  if (str(entryBar.trade_date) !== input.cardDate) return null
  const endBar = bars[bars.length - 1]
  if (str(endBar.trade_date) !== input.evaluateDate) return null
  const entryPrice = input.triggerPriceCents > 0
    ? input.triggerPriceCents
    : Math.round(num(entryBar.close) * 100)
  if (entryPrice <= 0) return null
  const entryOpen = Math.round(num(entryBar.open) * 100)
  const triggered = input.triggerOp === 'gte'
    ? entryOpen >= entryPrice
    : entryOpen <= entryPrice
  const endClose = Math.round(num(endBar.close) * 100)
  if (endClose <= 0) return null
  const returnBp = Math.round((endClose - entryPrice) * 10_000 / entryPrice)
  const lowest = Math.min(...bars.map((bar) => Math.round(num(bar.low) * 100) || entryPrice))
  const maxAdverseBp = Math.round((lowest - entryPrice) * 10_000 / entryPrice)

  // 触发价来自决策日收盘（cardDate 的前一交易日），基准必须同起点，否则少算一整个交易日。
  const benchStartR = await db.execute({
    sql: `SELECT close FROM market_bars
          WHERE code = ? AND trade_date < ? AND adjust_type = 'raw'
          ORDER BY trade_date DESC LIMIT 1`,
    args: [input.benchmark, input.cardDate],
  })
  const benchEndR = await db.execute({
    sql: `SELECT close FROM market_bars
          WHERE code = ? AND trade_date = ? AND adjust_type = 'raw' LIMIT 1`,
    args: [input.benchmark, input.evaluateDate],
  })
  if (!benchStartR.rows.length || !benchEndR.rows.length) return null
  const benchStart = Math.round(num(benchStartR.rows[0].close) * 100)
  const benchEnd = Math.round(num(benchEndR.rows[0].close) * 100)
  if (benchStart <= 0) return null
  const benchmarkReturnBp = Math.round((benchEnd - benchStart) * 10_000 / benchStart)
  const alphaBp = returnBp - benchmarkReturnBp
  const invalidationHit = input.status === 'invalidated'
    || (input.stopPriceCents > 0 && endClose <= input.stopPriceCents)
  let reasonClass: string | null = null
  if (!triggered) reasonClass = 'not_triggered'
  else if (alphaBp >= 0) reasonClass = invalidationHit ? 'right_luck' : 'right_reason'
  else reasonClass = invalidationHit ? 'wrong_reason' : 'wrong_luck'

  return {
    cardId: input.cardId,
    horizonDays: input.horizon,
    returnBp,
    benchmarkReturnBp,
    alphaBp,
    maxAdverseBp,
    hit: alphaBp >= 0 ? 1 : 0,
    reasonClass,
    invalidationHit: invalidationHit ? 1 : 0,
    notes: `${input.cardDate} 起 ${input.horizon} 个交易日，触发价 ¥${(input.triggerPriceCents / 100).toFixed(2)}，`
      + `评估日收盘 ¥${(endClose / 100).toFixed(2)}`,
    evaluateDate: input.evaluateDate,
    dataQuality: 'pass',
  }
}
