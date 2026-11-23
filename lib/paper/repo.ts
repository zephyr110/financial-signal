import crypto from 'crypto'
import { getDb } from '../db'
import {
  derivePositions,
  PaperLedgerError,
  reconcileLedger,
  type LedgerCashEntry,
  type LedgerLot,
  type LedgerLotClose,
  type LedgerReconciliation,
  type LedgerReservation,
} from './ledger'
import { averageDailyTurnoverCents } from './market'
import { policyHash, validatePaperPolicy } from './policy'
import type { RiskPosition } from './risk'
import type {
  DataQuality,
  DailyBar,
  MarketStatus,
  PaperPolicy,
  PriceLimit,
  SymbolMeta,
} from './types'

/**
 * 纸面盘仓储：实验/账户/账本读取、行情输入装配、审计哈希链、对账与重建。
 * 账本只追加；账户现金与持仓是按流水派生的物化视图，可用重建校验。
 */

export type PaperRepoErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'POLICY_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DATA_QUALITY'
  | 'MISSING_PRICE'
  | 'TOO_LATE'
  | 'RISK_REJECTED'

export class PaperRepoError extends Error {
  code: PaperRepoErrorCode
  /** 风控拒绝时带出规约原因码与全部违规项，API 直接回给前端。 */
  detail?: Record<string, unknown>

  constructor(code: PaperRepoErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'PaperRepoError'
    this.code = code
    this.detail = detail
  }
}

type Row = Record<string, unknown>
type Conn = { execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Row[]; rowsAffected: number }> }

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString()
}

function tradeDateOf(iso: string): string {
  return iso.slice(0, 10)
}

/** 元/股 -> 分/股；官方日线最多两位小数，四舍五入到分。 */
function yuanToCents(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

export interface PaperAccountRow {
  id: string
  experimentId: string
  kind: 'user' | 'shadow'
  name: string
  initialCashCents: number
  cashCents: number
  status: 'active' | 'paused' | 'closed'
  isDemo: boolean
}

export interface PaperExperimentRow {
  id: string
  name: string
  protocolVersion: string
  policyVersion: string
  benchmarkCode: string
  initialCashCents: number
  status: 'planned' | 'active' | 'paused' | 'closed'
  protocolJson: string
  baselineJson: string
  startedAt: string | null
  plannedEndAt: string | null
  endedAt: string | null
  validDays: number
  pauseReason: string | null
  resetCount: number
  resetOf: string | null
  configJson: string
  createdAt: string
  updatedAt: string
}

export interface PaperRiskStateRow {
  accountId: string
  killSwitch: boolean
  killReason: string | null
  killSince: string | null
  missingPriceSince: string | null
  dataQuality: DataQuality
  releaseAfterDate: string | null
  lastEvaluatedAt: string | null
  updatedAt: string | null
}

export interface PaperLedgerData {
  entries: LedgerCashEntry[]
  lots: LedgerLot[]
  closes: LedgerLotClose[]
  reservations: LedgerReservation[]
  /** 流水合计（可用 + 冻结），不参与「可用现金」判断。 */
  cashTotalCents: number
  /** 当前冻结现金（held 现金冻结）。 */
  frozenCashCents: number
}

function mapAccount(row: Row): PaperAccountRow {
  return {
    id: str(row.id),
    experimentId: str(row.experiment_id),
    kind: str(row.kind) === 'shadow' ? 'shadow' : 'user',
    name: str(row.name),
    initialCashCents: num(row.initial_cash_cents),
    cashCents: num(row.cash_cents),
    status: str(row.status, 'active') as PaperAccountRow['status'],
    isDemo: num(row.is_demo) === 1,
  }
}

function mapExperiment(row: Row): PaperExperimentRow {
  return {
    id: str(row.id),
    name: str(row.name),
    protocolVersion: str(row.protocol_version, 'v1'),
    policyVersion: str(row.policy_version),
    benchmarkCode: str(row.benchmark_code),
    initialCashCents: num(row.initial_cash_cents),
    status: str(row.status, 'planned') as PaperExperimentRow['status'],
    protocolJson: str(row.protocol_json, '{}'),
    baselineJson: str(row.baseline_json, '{}'),
    startedAt: str(row.started_at) || null,
    plannedEndAt: str(row.planned_end_at) || null,
    endedAt: str(row.ended_at) || null,
    validDays: num(row.valid_days),
    pauseReason: str(row.pause_reason) || null,
    resetCount: num(row.reset_count),
    resetOf: str(row.reset_of) || null,
    configJson: str(row.config_json, '{}'),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  }
}

export async function ensurePaperPolicyVersion(
  policy: PaperPolicy,
  opts: { activate?: boolean; now?: string } = {},
): Promise<{ version: string; hash: string; inserted: boolean }> {
  validatePaperPolicy(policy)
  const db = await getDb()
  const createdAt = nowIso(opts.now)
  const hash = await insertPolicyVersion(db, policy, createdAt, opts.activate !== false)
  return { version: policy.version, hash: hash.hash, inserted: hash.inserted }
}

async function insertPolicyVersion(
  conn: Conn,
  policy: PaperPolicy,
  createdAt: string,
  activate: boolean,
): Promise<{ hash: string; inserted: boolean }> {
  const hash = policyHash(policy)
  const existing = await conn.execute({
    sql: 'SELECT policy_hash FROM paper_policy_versions WHERE version = ?',
    args: [policy.version],
  })
  if (existing.rows.length > 0) {
    if (str(existing.rows[0].policy_hash) !== hash) {
      throw new PaperRepoError('POLICY_MISMATCH',
        `政策 ${policy.version} 已存在且内容不同；改参数必须新建版本`)
    }
    return { hash, inserted: false }
  }
  if (activate) {
    await conn.execute({ sql: 'UPDATE paper_policy_versions SET is_active = 0 WHERE is_active = 1', args: [] })
  }
  await conn.execute({
    sql: `INSERT INTO paper_policy_versions (version, policy_json, policy_hash, is_active, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [policy.version, JSON.stringify(policy), hash, activate ? 1 : 0, createdAt],
  })
  return { hash, inserted: true }
}

export interface CreatePaperExperimentInput {
  id?: string
  name: string
  protocolVersion: string
  benchmarkCode: string
  initialCashCents: number
  policy: PaperPolicy
  startedAt?: string | null
  plannedEndAt?: string | null
  protocol?: Record<string, unknown>
  baseline?: Record<string, unknown>
  config?: Record<string, unknown>
  isDemo?: boolean
  now?: string
}

export interface CreatedPaperExperiment {
  experiment: PaperExperimentRow
  accounts: PaperAccountRow[]
  policyVersion: string
  policyHash: string
}

function assertCreateInput(input: CreatePaperExperimentInput): void {
  if (!input.name?.trim()) throw new PaperRepoError('INVALID_INPUT', '实验名称不能为空')
  if (!input.benchmarkCode?.trim()) throw new PaperRepoError('INVALID_INPUT', '基准代码不能为空')
  if (!Number.isSafeInteger(input.initialCashCents) || input.initialCashCents <= 0) {
    throw new PaperRepoError('INVALID_INPUT', '初始资金必须为正整数分')
  }
  validatePaperPolicy(input.policy)
}

/** 在调用方事务内建实验；重置与新建共用，保证旧实验关闭与新实验创建同事务提交。 */
export async function insertPaperExperiment(
  conn: Conn,
  input: CreatePaperExperimentInput,
): Promise<{ experimentId: string; accountIds: Record<'user' | 'shadow', string>; policyHash: string }> {
  assertCreateInput(input)
  // 事务内再查一次：并发的新建请求会排队，后到的那个必须看到先提交的实验。
  const open = await conn.execute({
    sql: `SELECT id FROM paper_experiments WHERE status IN ('active','paused','planned') LIMIT 1`,
    args: [],
  })
  if (open.rows.length) {
    throw new PaperRepoError('INVALID_STATE', '已有未结束的实验，请先暂停、重置或关闭', {
      experimentId: String(open.rows[0].id),
    })
  }
  const now = nowIso(input.now)
  const experimentId = input.id ?? `exp-${crypto.randomUUID()}`
  const startedAt = input.startedAt ?? now
  const userId = `acc-${crypto.randomUUID()}`
  const shadowId = `shadow-${crypto.randomUUID()}`
  const initDate = tradeDateOf(startedAt)
  const { hash } = await insertPolicyVersion(conn, input.policy, now, true)
  await conn.execute({
    sql: `INSERT INTO paper_experiments
      (id, name, protocol_version, policy_version, benchmark_code, initial_cash_cents, status,
       protocol_json, baseline_json, started_at, planned_end_at, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      experimentId,
      input.name.trim(),
      input.protocolVersion,
      input.policy.version,
      input.benchmarkCode.trim(),
      input.initialCashCents,
      JSON.stringify(input.protocol ?? {}),
      JSON.stringify(input.baseline ?? {}),
      startedAt,
      input.plannedEndAt ?? null,
      JSON.stringify(input.config ?? {}),
      now,
      now,
    ],
  })

  const accounts: Array<[string, 'user' | 'shadow', string]> = [
    [userId, 'user', '主账户'],
    [shadowId, 'shadow', '影子账户'],
  ]
  for (const [accountId, kind, name] of accounts) {
    await conn.execute({
      sql: `INSERT INTO paper_accounts
        (id, experiment_id, kind, name, initial_cash_cents, cash_cents, status, is_demo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [accountId, experimentId, kind, name, input.initialCashCents, input.initialCashCents,
        input.isDemo ? 1 : 0, now],
    })
    await conn.execute({
      sql: `INSERT INTO paper_cash_entries
        (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, trade_date, memo, created_at)
        VALUES (?, ?, 'initial', ?, ?, 'account', ?, ?, '期初资金', ?)`,
      args: [`init-${accountId}`, accountId, input.initialCashCents, input.initialCashCents,
        accountId, initDate, now],
    })
    await conn.execute({
      sql: `INSERT INTO paper_risk_state (account_id, updated_at) VALUES (?, ?)
            ON CONFLICT(account_id) DO NOTHING`,
      args: [accountId, now],
    })
  }

  await writePaperAudit(conn, {
    actor: 'system',
    action: 'experiment.created',
    entityType: 'paper_experiment',
    entityId: experimentId,
    payload: {
      name: input.name,
      policyVersion: input.policy.version,
      policyHash: hash,
      protocolHash: crypto.createHash('sha256')
        .update(JSON.stringify(input.protocol ?? {}))
        .digest('hex'),
      resetOf: (input.config as { resetFrom?: string } | undefined)?.resetFrom ?? null,
    },
    createdAt: now,
  })
  return { experimentId, accountIds: { user: userId, shadow: shadowId }, policyHash: hash }
}

export async function createPaperExperiment(
  input: CreatePaperExperimentInput,
): Promise<CreatedPaperExperiment> {
  const db = await getDb()
  const tx = await db.transaction('write')
  let experimentId = ''
  try {
    experimentId = (await insertPaperExperiment(tx, input)).experimentId
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }

  const experiment = await getPaperExperiment(experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', '实验创建后读取失败')
  return {
    experiment,
    accounts: await listPaperAccounts(experimentId),
    policyVersion: input.policy.version,
    policyHash: policyHash(input.policy),
  }
}

export async function getPaperExperiment(id: string): Promise<PaperExperimentRow | null> {
  const db = await getDb()
  const r = await db.execute({ sql: 'SELECT * FROM paper_experiments WHERE id = ?', args: [id] })
  return r.rows.length ? mapExperiment(r.rows[0]) : null
}

/** 同一时间只允许一个活动/暂停/待开始的实验；active 优先，其次 paused、planned。 */
export async function getCurrentPaperExperiment(): Promise<PaperExperimentRow | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT * FROM paper_experiments
          WHERE status IN ('active','paused','planned')
          ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                   created_at DESC
          LIMIT 1`,
    args: [],
  })
  return r.rows.length ? mapExperiment(r.rows[0]) : null
}

export async function getPaperAccount(id: string): Promise<PaperAccountRow | null> {
  const db = await getDb()
  const r = await db.execute({ sql: 'SELECT * FROM paper_accounts WHERE id = ?', args: [id] })
  return r.rows.length ? mapAccount(r.rows[0]) : null
}

export async function listPaperAccounts(experimentId: string): Promise<PaperAccountRow[]> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT * FROM paper_accounts WHERE experiment_id = ? ORDER BY kind, created_at',
    args: [experimentId],
  })
  return r.rows.map(mapAccount)
}

/** 读取实验锁定的政策并核对哈希；版本内容被篡改时拒绝结算。 */
export async function getPaperExperimentPolicy(
  experimentId: string,
): Promise<{ policy: PaperPolicy; hash: string }> {
  const experiment = await getPaperExperiment(experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', `实验不存在: ${experimentId}`)
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT policy_json, policy_hash FROM paper_policy_versions WHERE version = ?',
    args: [experiment.policyVersion],
  })
  if (!r.rows.length) throw new PaperRepoError('NOT_FOUND', `政策版本不存在: ${experiment.policyVersion}`)
  const policy = parseJson<PaperPolicy | null>(r.rows[0].policy_json, null)
  if (!policy) throw new PaperRepoError('DATA_QUALITY', '政策内容无法解析')
  validatePaperPolicy(policy)
  const hash = policyHash(policy)
  if (hash !== str(r.rows[0].policy_hash)) {
    throw new PaperRepoError('POLICY_MISMATCH', `政策 ${policy.version} 哈希不一致`)
  }
  return { policy, hash }
}

export async function getPaperRiskState(accountId: string): Promise<PaperRiskStateRow> {
  const db = await getDb()
  const r = await db.execute({ sql: 'SELECT * FROM paper_risk_state WHERE account_id = ?', args: [accountId] })
  const row = r.rows[0]
  if (!row) {
    return {
      accountId,
      killSwitch: false,
      killReason: null,
      killSince: null,
      missingPriceSince: null,
      dataQuality: 'pass',
      releaseAfterDate: null,
      lastEvaluatedAt: null,
      updatedAt: null,
    }
  }
  return {
    accountId,
    killSwitch: num(row.kill_switch) === 1,
    killReason: str(row.kill_reason) || null,
    killSince: str(row.kill_since) || null,
    missingPriceSince: str(row.missing_price_since) || null,
    dataQuality: str(row.data_quality, 'pass') as DataQuality,
    releaseAfterDate: str(row.release_after_date) || null,
    lastEvaluatedAt: str(row.last_evaluated_at) || null,
    updatedAt: str(row.updated_at) || null,
  }
}

function mapCashEntry(row: Row): LedgerCashEntry {
  return {
    id: str(row.id),
    accountId: str(row.account_id),
    kind: str(row.kind) as LedgerCashEntry['kind'],
    amountCents: num(row.amount_cents),
    balanceAfterCents: num(row.balance_after_cents),
    refType: str(row.ref_type),
    refId: str(row.ref_id),
    tradeDate: str(row.trade_date),
    orderId: str(row.order_id) || null,
    fillId: str(row.fill_id) || null,
  }
}

function mapLot(row: Row): LedgerLot {
  return {
    id: str(row.id),
    accountId: str(row.account_id),
    symbolCode: str(row.symbol_code),
    openFillId: str(row.open_fill_id),
    openDate: str(row.open_date),
    qtyOpened: num(row.qty),
    costTotalCents: num(row.cost_total_cents),
  }
}

function mapClose(row: Row): LedgerLotClose {
  return {
    id: str(row.id),
    sellFillId: str(row.sell_fill_id),
    lotId: str(row.lot_id),
    qty: num(row.qty),
    costCents: num(row.cost_cents),
    proceedsCents: num(row.proceeds_cents),
    realizedPnlCents: num(row.realized_pnl_cents),
    holdingDays: num(row.holding_days),
    dividendTaxCents: num(row.dividend_tax_cents),
  }
}

function mapReservation(row: Row): LedgerReservation {
  return {
    id: str(row.id),
    accountId: str(row.account_id),
    orderId: str(row.order_id),
    kind: str(row.kind) === 'shares' ? 'shares' : 'cash',
    symbolCode: str(row.symbol_code) || null,
    amountCents: num(row.amount_cents),
    qty: num(row.qty),
    status: str(row.status) as LedgerReservation['status'],
  }
}

export async function loadPaperLedger(accountId: string, conn?: Conn): Promise<PaperLedgerData> {
  const db = conn ?? (await getDb())
  const [entries, lots, closes, reservations] = await Promise.all([
    db.execute({
      sql: 'SELECT * FROM paper_cash_entries WHERE account_id = ? ORDER BY created_at, id',
      args: [accountId],
    }),
    db.execute({
      sql: 'SELECT * FROM paper_tax_lots WHERE account_id = ? ORDER BY open_date, id',
      args: [accountId],
    }),
    db.execute({
      sql: `SELECT c.* FROM paper_lot_closes c
            JOIN paper_tax_lots l ON l.id = c.lot_id
            WHERE l.account_id = ? ORDER BY c.created_at, c.id`,
      args: [accountId],
    }),
    db.execute({
      sql: 'SELECT * FROM paper_reservations WHERE account_id = ? ORDER BY created_at, id',
      args: [accountId],
    }),
  ])
  const cashEntries = entries.rows.map(mapCashEntry)
  return {
    entries: cashEntries,
    lots: lots.rows.map(mapLot),
    closes: closes.rows.map(mapClose),
    reservations: reservations.rows.map(mapReservation),
    cashTotalCents: cashEntries.reduce((sum, e) => sum + e.amountCents, 0),
    frozenCashCents: reservations.rows
      .map(mapReservation)
      .filter((r) => r.kind === 'cash' && r.status === 'held')
      .reduce((sum, r) => sum + r.amountCents, 0),
  }
}

function mapSymbolMetaRow(row: Row): SymbolMeta {
  return {
    symbolCode: str(row.symbol_code),
    name: str(row.name),
    exchange: str(row.exchange) as SymbolMeta['exchange'],
    board: str(row.board) as SymbolMeta['board'],
    industryCode: str(row.industry_code) || null,
    industryName: str(row.industry_name) || null,
    isSt: num(row.is_st) === 1,
    lotSize: num(row.lot_size),
    limitPctBp: row.limit_pct_bp == null ? null : num(row.limit_pct_bp),
    noPriceLimit: num(row.no_price_limit) === 1,
    listDate: str(row.listed_at) || null,
    delistDate: str(row.delisted_at) || null,
    sourceId: str(row.source_id),
    validFrom: str(row.valid_from),
    validTo: str(row.valid_to) || null,
  }
}

export interface PaperMarketInputs {
  meta: SymbolMeta | null
  market: {
    bar: DailyBar | null
    limit: PriceLimit | null
    status: MarketStatus | null
    priceSourceId?: string
    barFetchedAt?: string | null
    barHash?: string | null
  }
}

/** 结算输入：SCD2 元数据按目标日取有效行，日线固定用原始价（不复权）。 */
export async function loadPaperMarketInputs(
  symbolCode: string,
  tradeDate: string,
): Promise<PaperMarketInputs> {
  const db = await getDb()
  const [metaR, statusR, limitR, barR] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM paper_symbol_meta
            WHERE symbol_code = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
            ORDER BY valid_from DESC LIMIT 1`,
      args: [symbolCode, tradeDate, tradeDate],
    }),
    db.execute({
      sql: 'SELECT * FROM paper_market_status_daily WHERE symbol_code = ? AND trade_date = ?',
      args: [symbolCode, tradeDate],
    }),
    db.execute({
      sql: 'SELECT * FROM paper_limit_price_daily WHERE symbol_code = ? AND trade_date = ?',
      args: [symbolCode, tradeDate],
    }),
    db.execute({
      sql: `SELECT open, close, amount, source_id, fetched_at FROM market_bars
            WHERE code = ? AND trade_date = ? AND adjust_type = 'raw' LIMIT 1`,
      args: [symbolCode, tradeDate],
    }),
  ])

  const meta: SymbolMeta | null = metaR.rows.length ? mapSymbolMetaRow(metaR.rows[0]) : null

  const statusRow = statusR.rows[0]
  const status: MarketStatus | null = statusRow
    ? {
        symbolCode: str(statusRow.symbol_code),
        tradeDate: str(statusRow.trade_date),
        isSuspended: num(statusRow.is_suspended) === 1,
        isSt: num(statusRow.is_st) === 1,
        source: str(statusRow.status_source),
      }
    : null

  const limitRow = limitR.rows[0]
  const limit: PriceLimit | null = limitRow
    ? {
        symbolCode: str(limitRow.symbol_code),
        tradeDate: str(limitRow.trade_date),
        limitUpCents: num(limitRow.limit_up_cents),
        limitDownCents: num(limitRow.limit_down_cents),
        sourceId: str(limitRow.source_id),
      }
    : null

  const barRow = barR.rows[0]
  const barOpenCents = barRow ? yuanToCents(barRow.open) : null
  const barCloseCents = barRow ? yuanToCents(barRow.close) : null
  const amount = barRow ? Number(barRow.amount) : NaN
  const bar: DailyBar | null = barRow && barOpenCents && barCloseCents
    ? {
        symbolCode,
        tradeDate,
        openCents: barOpenCents,
        closeCents: barCloseCents,
        prevCloseCents: null,
        amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
      }
    : null

  return {
    meta,
    market: {
      bar,
      limit,
      status,
      // 成交价的来源只能是行情行本身；limit/meta 的 source 只说明限额与元数据出处。
      priceSourceId: barRow ? str(barRow.source_id) || undefined : undefined,
      barFetchedAt: barRow ? str(barRow.fetched_at) || null : null,
      barHash: null,
    },
  }
}

/** 交易日官方收盘价（分）；缺价返回 null，绝不用 0 代替。 */
export async function loadClosePriceCents(symbolCode: string, tradeDate: string): Promise<number | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT close FROM market_bars
          WHERE code = ? AND trade_date = ? AND adjust_type = 'raw' LIMIT 1`,
    args: [symbolCode, tradeDate],
  })
  return r.rows.length ? yuanToCents(r.rows[0].close) : null
}

/** 各批次未代扣的红利（税前）；卖出时据此随平仓预扣红利税。 */
export async function loadPendingDividendGrossByLot(
  accountId: string,
  conn?: Conn,
): Promise<Record<string, number>> {
  const db = conn ?? (await getDb())
  const r = await db.execute({
    sql: `SELECT lot_id, COALESCE(SUM(cash_cents), 0) AS gross
          FROM paper_dividend_entitlements
          WHERE account_id = ? AND tax_status = 'pending'
          GROUP BY lot_id`,
    args: [accountId],
  })
  const out: Record<string, number> = {}
  for (const row of r.rows) out[str(row.lot_id)] = num(row.gross)
  return out
}

export async function getPaperNavCents(
  accountId: string,
  onOrBefore: string,
): Promise<number | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT total_equity_cents FROM paper_nav
          WHERE account_id = ? AND trade_date <= ? ORDER BY trade_date DESC LIMIT 1`,
    args: [accountId, onOrBefore],
  })
  return r.rows.length ? num(r.rows[0].total_equity_cents) : null
}

export async function recordPaperNav(input: {
  accountId: string
  tradeDate: string
  cashCents: number
  frozenCashCents?: number
  marketValueCents: number
  totalEquityCents: number
  dailyReturnBp?: number | null
  drawdownBp?: number | null
  benchmark?: Record<string, unknown>
  quality?: DataQuality
  isDemo?: boolean
  now?: string
}): Promise<void> {
  const db = await getDb()
  await db.execute({
    sql: `INSERT INTO paper_nav
      (account_id, trade_date, cash_cents, frozen_cash_cents, market_value_cents, total_equity_cents,
       daily_return_bp, drawdown_bp, benchmark_json, quality, is_demo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, trade_date) DO NOTHING`,
    args: [
      input.accountId, input.tradeDate, input.cashCents, input.frozenCashCents ?? 0,
      input.marketValueCents, input.totalEquityCents,
      input.dailyReturnBp ?? null, input.drawdownBp ?? null,
      JSON.stringify(input.benchmark ?? {}), input.quality ?? 'pass',
      input.isDemo ? 1 : 0, nowIso(input.now),
    ],
  })
}

export async function getPaperNavRow(
  accountId: string,
  tradeDate: string,
): Promise<{ totalEquityCents: number; quality: DataQuality } | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT total_equity_cents, quality FROM paper_nav WHERE account_id = ? AND trade_date = ?',
    args: [accountId, tradeDate],
  })
  if (!r.rows.length) return null
  return {
    totalEquityCents: num(r.rows[0].total_equity_cents),
    quality: str(r.rows[0].quality, 'pass') as DataQuality,
  }
}

export async function loadMaterializedPositions(accountId: string): Promise<Array<{
  symbolCode: string
  totalQty: number
  availableQty: number
  frozenQty: number
}>> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT symbol_code, total_qty, available_qty, frozen_qty FROM paper_positions WHERE account_id = ?',
    args: [accountId],
  })
  return r.rows.map((row) => ({
    symbolCode: str(row.symbol_code),
    totalQty: num(row.total_qty),
    availableQty: num(row.available_qty),
    frozenQty: num(row.frozen_qty),
  }))
}

/** 用现金流水与冻结重算可用现金；超出流水时抛错（事务回滚）。 */
export async function refreshPaperAccountCash(conn: Conn, accountId: string): Promise<number> {
  const totalR = await conn.execute({
    sql: 'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM paper_cash_entries WHERE account_id = ?',
    args: [accountId],
  })
  const heldR = await conn.execute({
    sql: `SELECT COALESCE(SUM(amount_cents), 0) AS held FROM paper_reservations
          WHERE account_id = ? AND kind = 'cash' AND status = 'held'`,
    args: [accountId],
  })
  const total = num(totalR.rows[0]?.total)
  const held = num(heldR.rows[0]?.held)
  const spendable = total - held
  if (spendable < 0) {
    throw new PaperRepoError('INVALID_STATE', `可用现金为负: ${spendable} 分`)
  }
  await conn.execute({
    sql: 'UPDATE paper_accounts SET cash_cents = ? WHERE id = ?',
    args: [spendable, accountId],
  })
  return spendable
}

/** 物化持仓整体重建：持仓表允许重写，真相始终来自流水与批次。 */
export async function refreshPaperPositions(
  conn: Conn,
  accountId: string,
  tradeDate: string,
): Promise<void> {
  const ledger = await loadPaperLedger(accountId, conn)
  const positions = derivePositions({
    lots: ledger.lots,
    closes: ledger.closes,
    reservations: ledger.reservations,
    tradeDate,
  })
  await conn.execute({ sql: 'DELETE FROM paper_positions WHERE account_id = ?', args: [accountId] })
  const updatedAt = new Date().toISOString()
  for (const p of positions) {
    await conn.execute({
      sql: `INSERT INTO paper_positions
        (account_id, symbol_code, total_qty, available_qty, frozen_qty, avg_cost_cents, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [accountId, p.symbolCode, p.totalQty, p.availableQty, p.frozenQty, p.avgCostCents, updatedAt],
    })
  }
}

/** 审计哈希链：每条包含前一条哈希，断链可被复核发现。 */
export async function writePaperAudit(conn: Conn, input: {
  actor: string
  action: string
  entityType: string
  entityId?: string | null
  requestHash?: string | null
  taskId?: string | null
  cardId?: string | null
  orderId?: string | null
  payload?: unknown
  createdAt?: string
}): Promise<string> {
  const createdAt = nowIso(input.createdAt)
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload)
  const prevR = await conn.execute({
    sql: 'SELECT hash FROM paper_audit_log ORDER BY id DESC LIMIT 1',
    args: [],
  })
  const prevHash = prevR.rows.length ? str(prevR.rows[0].hash) : ''
  const hash = crypto.createHash('sha256')
    .update([
      prevHash,
      input.actor,
      input.action,
      input.entityType,
      input.entityId ?? '',
      input.requestHash ?? '',
      payloadJson ?? '',
      createdAt,
    ].join('|'))
    .digest('hex')
  await conn.execute({
    sql: `INSERT INTO paper_audit_log
      (actor, action, entity_type, entity_id, request_hash, task_id, card_id, order_id,
       payload_json, prev_hash, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.actor, input.action, input.entityType, input.entityId ?? null,
      input.requestHash ?? null, input.taskId ?? null, input.cardId ?? null, input.orderId ?? null,
      payloadJson, prevHash || null, hash, createdAt,
    ],
  })
  return hash
}

/** 写入风控事件；kill switch 与数据质量状态同步到 paper_risk_state。 */
export async function recordPaperRiskEvent(
  conn: Conn,
  input: {
    accountId: string
    rule: string
    severity: 'info' | 'warn' | 'block'
    action: string
    message: string
    threshold?: number | null
    actual?: number | null
    detail?: unknown
    dataQuality?: DataQuality
    orderId?: string | null
    cardId?: string | null
    refType?: string | null
    refId?: string | null
    createdAt?: string
  },
): Promise<string> {
  const id = `risk-${crypto.randomUUID()}`
  const createdAt = nowIso(input.createdAt)
  await conn.execute({
    sql: `INSERT INTO paper_risk_events
      (id, account_id, order_id, card_id, rule, severity, threshold_value, actual_value,
       action, message, detail_json, data_quality, ref_type, ref_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, input.accountId, input.orderId ?? null, input.cardId ?? null, input.rule,
      input.severity, input.threshold ?? null, input.actual ?? null, input.action,
      input.message, JSON.stringify(input.detail ?? {}), input.dataQuality ?? 'pass',
      input.refType ?? null, input.refId ?? null, createdAt,
    ],
  })
  return id
}

export async function setPaperKillSwitch(input: {
  accountId: string
  reason: string
  now?: string
  releaseAfterDate?: string | null
}): Promise<void> {
  const db = await getDb()
  const now = nowIso(input.now)
  await db.execute({
    sql: `INSERT INTO paper_risk_state (account_id, kill_switch, kill_reason, kill_since, release_after_date, updated_at)
          VALUES (?, 1, ?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            kill_switch = 1, kill_reason = excluded.kill_reason,
            kill_since = COALESCE(paper_risk_state.kill_since, excluded.kill_since),
            release_after_date = excluded.release_after_date, updated_at = excluded.updated_at`,
    args: [input.accountId, input.reason, now, input.releaseAfterDate ?? null, now],
  })
}

/** 结算遇缺价：账户进入 MISSING_PRICE，禁止新买入；对账确认数据完整后再清除。 */
export async function setPaperMissingPriceState(input: {
  accountId: string
  since: string
  now?: string
}): Promise<void> {
  const db = await getDb()
  const now = nowIso(input.now)
  await db.execute({
    sql: `INSERT INTO paper_risk_state
            (account_id, kill_switch, missing_price_since, data_quality, updated_at)
          VALUES (?, 0, ?, 'fail', ?)
          ON CONFLICT(account_id) DO UPDATE SET
            missing_price_since = COALESCE(paper_risk_state.missing_price_since, excluded.missing_price_since),
            data_quality = 'fail', updated_at = excluded.updated_at`,
    args: [input.accountId, input.since, now],
  })
}

export async function clearPaperMissingPriceState(input: {
  accountId: string
  now?: string
}): Promise<void> {
  const db = await getDb()
  const now = nowIso(input.now)
  await db.execute({
    sql: `UPDATE paper_risk_state
          SET missing_price_since = NULL, data_quality = 'pass', updated_at = ?
          WHERE account_id = ? AND kill_switch = 0`,
    args: [now, input.accountId],
  })
}

export interface PaperReconciliationResult {
  id: string
  status: LedgerReconciliation['status']
  mismatchCents: number
  reconciliation: LedgerReconciliation
}

/**
 * 16:30 对账：四条恒等式 + 物化视图核对；fail 触发 kill switch，
 * 缺价只记为 missing_price，不按 0 估值。
 */
export async function reconcilePaperAccount(input: {
  accountId: string
  tradeDate: string
  now?: string
}): Promise<PaperReconciliationResult> {
  const account = await getPaperAccount(input.accountId)
  if (!account) throw new PaperRepoError('NOT_FOUND', `账户不存在: ${input.accountId}`)
  const ledger = await loadPaperLedger(input.accountId)
  const positions = derivePositions({
    lots: ledger.lots,
    closes: ledger.closes,
    reservations: ledger.reservations,
    tradeDate: input.tradeDate,
  })

  const pricesBySymbol: Record<string, number | null> = {}
  for (const p of positions) {
    if (p.totalQty === 0) continue
    pricesBySymbol[p.symbolCode] = await loadClosePriceCents(p.symbolCode, input.tradeDate)
  }

  const nav = await getPaperNavRow(input.accountId, input.tradeDate)
  const reconciliation = reconcileLedger({
    initialCashCents: account.initialCashCents,
    entries: ledger.entries,
    lots: ledger.lots,
    closes: ledger.closes,
    reservations: ledger.reservations,
    tradeDate: input.tradeDate,
    pricesBySymbol,
    accountCashCents: account.cashCents,
    navCents: nav?.totalEquityCents,
    materializedPositions: await loadMaterializedPositions(input.accountId),
  })

  const failed = reconciliation.checks.filter((c) => !c.pass && !c.skipped)
  const mismatchCents = failed.reduce((sum, c) => sum + Math.abs(c.diffCents ?? 0), 0)
  const id = `recon-${input.accountId}-${input.tradeDate}`
  const now = nowIso(input.now)
  const db = await getDb()

  await db.execute({
    sql: `INSERT INTO paper_reconciliations
      (id, account_id, trade_date, status, diffs_json, identities_json, mismatch_cents, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, trade_date) DO UPDATE SET
        status = excluded.status, diffs_json = excluded.diffs_json,
        identities_json = excluded.identities_json, mismatch_cents = excluded.mismatch_cents`,
    args: [
      id, input.accountId, input.tradeDate, reconciliation.status,
      JSON.stringify(failed), JSON.stringify(reconciliation.checks), mismatchCents, now,
    ],
  })

  if (reconciliation.status === 'fail') {
    await recordPaperRiskEvent(db, {
      accountId: input.accountId,
      rule: 'ledger_identity',
      severity: 'block',
      action: 'kill_switch',
      message: `账本对账失败：${failed.map((c) => c.name).join(', ')}`,
      actual: mismatchCents,
      detail: failed,
      dataQuality: 'fail',
      refType: 'reconciliation',
      refId: id,
      createdAt: now,
    })
    await setPaperKillSwitch({ accountId: input.accountId, reason: 'LEDGER_MISMATCH', now })
  } else if (reconciliation.status === 'missing_price') {
    await recordPaperRiskEvent(db, {
      accountId: input.accountId,
      rule: 'missing_price',
      severity: 'warn',
      action: 'flag',
      message: `缺价未估值：${reconciliation.missingSymbols.join(', ') || '未知'}`,
      detail: { missingSymbols: reconciliation.missingSymbols },
      dataQuality: 'warn',
      refType: 'reconciliation',
      refId: id,
      createdAt: now,
    })
  }

  return { id, status: reconciliation.status, mismatchCents, reconciliation }
}

/** paper-rebuild：从流水重建账户现金与持仓物化视图。 */
export async function rebuildPaperAccount(input: {
  accountId: string
  tradeDate: string
}): Promise<{ cashCents: number; frozenCashCents: number; positions: ReturnType<typeof derivePositions> }> {
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    const cashCents = await refreshPaperAccountCash(tx, input.accountId)
    await refreshPaperPositions(tx, input.accountId, input.tradeDate)
    const ledger = await loadPaperLedger(input.accountId, tx)
    await tx.commit()
    const positions = derivePositions({
      lots: ledger.lots,
      closes: ledger.closes,
      reservations: ledger.reservations,
      tradeDate: input.tradeDate,
    })
    return { cashCents, frozenCashCents: ledger.frozenCashCents, positions }
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }
}

/** 对账记录（只读展示用；完整 identities 见 identities_json）。 */
export async function getPaperReconciliationRecord(
  accountId: string,
  tradeDate: string,
): Promise<{ id: string; status: LedgerReconciliation['status']; mismatchCents: number; checks: unknown[] } | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT * FROM paper_reconciliations WHERE account_id = ? AND trade_date = ?',
    args: [accountId, tradeDate],
  })
  if (!r.rows.length) return null
  const row = r.rows[0]
  return {
    id: str(row.id),
    status: str(row.status) as LedgerReconciliation['status'],
    mismatchCents: num(row.mismatch_cents),
    checks: parseJson<unknown[]>(row.identities_json, []),
  }
}

export interface PaperSymbolContext {
  meta: SymbolMeta | null
  status: MarketStatus | null
  /** 目标日之前最近一根原始日线收盘价（分）；确认时用它估算成交额。 */
  lastCloseCents: number | null
  lastCloseDate: string | null
  adv20Cents: number | null
  listedTradingDays: number | null
}

/** 确认（execute）用的标的上下文：T-1 收盘、20 日成交额、上市交易日数。 */
export async function loadPaperSymbolContext(
  symbolCode: string,
  tradeDate: string,
): Promise<PaperSymbolContext> {
  const db = await getDb()
  const [metaR, statusR, barsR] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM paper_symbol_meta
            WHERE symbol_code = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
            ORDER BY valid_from DESC LIMIT 1`,
      args: [symbolCode, tradeDate, tradeDate],
    }),
    db.execute({
      sql: 'SELECT * FROM paper_market_status_daily WHERE symbol_code = ? AND trade_date = ?',
      args: [symbolCode, tradeDate],
    }),
    db.execute({
      sql: `SELECT trade_date, close, amount FROM market_bars
            WHERE code = ? AND trade_date < ? AND adjust_type = 'raw'
            ORDER BY trade_date DESC LIMIT 20`,
      args: [symbolCode, tradeDate],
    }),
  ])

  const meta = metaR.rows.length ? mapSymbolMetaRow(metaR.rows[0]) : null
  const statusRow = statusR.rows[0]
  const status: MarketStatus | null = statusRow
    ? {
        symbolCode: str(statusRow.symbol_code),
        tradeDate: str(statusRow.trade_date),
        isSuspended: num(statusRow.is_suspended) === 1,
        isSt: num(statusRow.is_st) === 1,
        source: str(statusRow.status_source),
      }
    : null

  const bars: DailyBar[] = barsR.rows.map((row) => {
    const amount = Number(row.amount)
    return {
      symbolCode,
      tradeDate: str(row.trade_date),
      openCents: 0,
      closeCents: yuanToCents(row.close) ?? 0,
      prevCloseCents: null,
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
    }
  })

  let listedTradingDays: number | null = null
  if (meta?.listDate) {
    const r = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM trading_calendar
            WHERE is_open = 1 AND trade_date >= ? AND trade_date <= ?`,
      args: [meta.listDate, tradeDate],
    })
    listedTradingDays = num(r.rows[0]?.n)
  }

  return {
    meta,
    status,
    lastCloseCents: bars.length ? bars[0].closeCents : null,
    lastCloseDate: bars.length ? bars[0].tradeDate : null,
    adv20Cents: averageDailyTurnoverCents(bars, 20),
    listedTradingDays,
  }
}

export interface PaperRiskSnapshot {
  navCents: number | null
  cashCents: number
  /** 按目标日派生的持仓（可用数量已扣掉在途卖出冻结）。 */
  positions: RiskPosition[]
  missingPriceSymbols: string[]
  dailyOrders: number
  dailyNewPositions: number
  dailyLossBp: number | null
  drawdownBp: number | null
}

/** 确认前的风控快照：净值、持仓估值、当日委托计数与回撤；缺价不按 0 估值。 */
export async function loadPaperRiskSnapshot(input: {
  accountId: string
  tradeDate: string
}): Promise<PaperRiskSnapshot> {
  const db = await getDb()
  const account = await getPaperAccount(input.accountId)
  if (!account) throw new PaperRepoError('NOT_FOUND', `账户不存在: ${input.accountId}`)
  const ledger = await loadPaperLedger(input.accountId)

  let derived
  try {
    derived = derivePositions({
      lots: ledger.lots,
      closes: ledger.closes,
      reservations: ledger.reservations,
      tradeDate: input.tradeDate,
    })
  } catch (err) {
    if (err instanceof PaperLedgerError) {
      throw new PaperRepoError('DATA_QUALITY', `持仓派生失败: ${err.message}`)
    }
    throw err
  }

  const positions: RiskPosition[] = []
  const missingPriceSymbols: string[] = []
  for (const p of derived) {
    if (p.totalQty === 0) continue
    const [closeR, metaR] = await Promise.all([
      db.execute({
        sql: `SELECT close FROM market_bars
              WHERE code = ? AND trade_date <= ? AND adjust_type = 'raw'
              ORDER BY trade_date DESC LIMIT 1`,
        args: [p.symbolCode, input.tradeDate],
      }),
      db.execute({
        sql: `SELECT industry_code FROM paper_symbol_meta
              WHERE symbol_code = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
              ORDER BY valid_from DESC LIMIT 1`,
        args: [p.symbolCode, input.tradeDate, input.tradeDate],
      }),
    ])
    const closeCents = closeR.rows.length ? yuanToCents(closeR.rows[0].close) : null
    if (!closeCents) missingPriceSymbols.push(p.symbolCode)
    positions.push({
      symbolCode: p.symbolCode,
      industryCode: metaR.rows.length ? (str(metaR.rows[0].industry_code) || null) : null,
      marketValueCents: (closeCents ?? 0) * p.totalQty,
      totalQty: p.totalQty,
      availableQty: p.availableQty,
    })
  }

  const navR = await db.execute({
    sql: `SELECT trade_date, total_equity_cents FROM paper_nav
          WHERE account_id = ? AND trade_date <= ?
          ORDER BY trade_date DESC LIMIT 2`,
    args: [input.accountId, input.tradeDate],
  })
  const latestNav = navR.rows.length ? num(navR.rows[0].total_equity_cents) : null
  const prevNav = navR.rows.length > 1 ? num(navR.rows[1].total_equity_cents) : null
  const peakR = await db.execute({
    sql: 'SELECT MAX(total_equity_cents) AS peak FROM paper_nav WHERE account_id = ? AND trade_date <= ?',
    args: [input.accountId, input.tradeDate],
  })
  const peakNav = peakR.rows.length && peakR.rows[0].peak != null ? num(peakR.rows[0].peak) : null
  const dailyLossBp = latestNav != null && prevNav != null && prevNav > 0
    ? Math.max(0, Math.round((prevNav - latestNav) * 10_000 / prevNav))
    : null
  const drawdownBp = latestNav != null && peakNav != null && peakNav > 0
    ? Math.max(0, Math.round((peakNav - latestNav) * 10_000 / peakNav))
    : null

  const [ordersR, newPosR] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM paper_orders
            WHERE account_id = ? AND target_trade_date = ?
              AND status IN ('confirmed','settlement_pending','filled')`,
      args: [input.accountId, input.tradeDate],
    }),
    db.execute({
      sql: `SELECT COUNT(DISTINCT o.symbol_code) AS n FROM paper_orders o
            WHERE o.account_id = ? AND o.target_trade_date = ? AND o.side = 'buy'
              AND o.status IN ('confirmed','settlement_pending','filled')
              AND NOT EXISTS (
                SELECT 1 FROM paper_tax_lots l
                WHERE l.account_id = o.account_id AND l.symbol_code = o.symbol_code
                  AND l.open_date < ?
              )`,
      args: [input.accountId, input.tradeDate, input.tradeDate],
    }),
  ])

  // 首日或估值任务尚未跑过时没有 nav 行；用现金 + 持仓市值兜底，否则 08:30 无法确认任何买入。
  const navFallback = account.cashCents + ledger.frozenCashCents
    + positions.reduce((sum, p) => sum + p.marketValueCents, 0)
  return {
    navCents: latestNav ?? (navFallback > 0 ? navFallback : null),
    cashCents: account.cashCents,
    positions,
    missingPriceSymbols,
    dailyOrders: num(ordersR.rows[0]?.n),
    dailyNewPositions: num(newPosR.rows[0]?.n),
    dailyLossBp,
    drawdownBp,
  }
}
