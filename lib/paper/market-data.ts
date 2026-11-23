import { getDb } from '../db'
import { theoreticalLimitPrices } from './market'
import type { PaperBoard } from './types'

/**
 * 结算依赖的停牌状态与涨跌停价此前没有生产写入方，导致所有委托 expire。
 * 这里从已入库日线与元数据推导并落库；真实来源的行不覆盖，只在 derived 行上刷新。
 */

const DERIVED_SOURCE = 'derived_bar'

type Mode = 'preopen' | 'settle'

interface SymbolRow {
  symbolCode: string
  isSt: boolean
  board: PaperBoard | null
  noPriceLimit: boolean
}

function cents(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

async function loadSymbols(experimentId: string, tradeDate: string): Promise<string[]> {
  const db = await getDb()
  // 已移出自选但仍有在途委托的标的也要有限价，否则只会在结算时被判缺价。
  const r = await db.execute({
    sql: `SELECT symbol_code FROM (
            SELECT symbol_code FROM paper_universe
            WHERE experiment_id = ? AND removed_at IS NULL
            UNION
            SELECT p.symbol_code FROM paper_positions p
            JOIN paper_accounts a ON a.id = p.account_id
            WHERE a.experiment_id = ? AND p.total_qty > 0
            UNION
            SELECT symbol_code FROM paper_orders
            WHERE experiment_id = ? AND target_trade_date <= ?
              AND status IN ('confirmed','settlement_pending')
          ) ORDER BY symbol_code`,
    args: [experimentId, experimentId, experimentId, tradeDate],
  })
  return r.rows.map((row) => String(row.symbol_code)).filter(Boolean)
}

async function loadSymbolMeta(symbolCode: string, tradeDate: string): Promise<SymbolRow | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT is_st, board, no_price_limit FROM paper_symbol_meta
          WHERE symbol_code = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
          ORDER BY valid_from DESC LIMIT 1`,
    args: [symbolCode, tradeDate, tradeDate],
  })
  if (!r.rows.length) return null
  const row = r.rows[0]
  return {
    symbolCode,
    isSt: Number(row.is_st) === 1,
    board: row.board == null ? null : String(row.board) as PaperBoard,
    noPriceLimit: Number(row.no_price_limit) === 1,
  }
}

export interface PaperMarketDataResult {
  symbols: number
  statuses: number
  limits: number
}

export async function ensurePaperMarketData(input: {
  experimentId: string
  tradeDate: string
  /** preopen 时当日尚无日线，不能据此判定停牌，只补涨跌停价。 */
  mode: Mode
  now?: string
}): Promise<PaperMarketDataResult> {
  const now = input.now ?? new Date().toISOString()
  const db = await getDb()
  const symbols = await loadSymbols(input.experimentId, input.tradeDate)
  let statuses = 0
  let limits = 0

  for (const symbolCode of symbols) {
    const [barsR, meta, existingR] = await Promise.all([
      db.execute({
        sql: `SELECT trade_date, close FROM market_bars
              WHERE code = ? AND trade_date <= ? AND adjust_type = 'raw'
              ORDER BY trade_date DESC LIMIT 2`,
        args: [symbolCode, input.tradeDate],
      }),
      loadSymbolMeta(symbolCode, input.tradeDate),
      db.execute({
        sql: `SELECT is_suspended, is_st, status_source FROM paper_market_status_daily
              WHERE symbol_code = ? AND trade_date = ?`,
        args: [symbolCode, input.tradeDate],
      }),
    ])
    const rows = barsR.rows
    const hasBar = rows.length > 0 && String(rows[0].trade_date) === input.tradeDate
    const prevClose = hasBar ? (rows[1] ? cents(rows[1].close) : null) : (rows[0] ? cents(rows[0].close) : null)
    if (!hasBar && !prevClose) continue

    const existing = existingR.rows[0]
    const external = existing && String(existing.status_source) !== DERIVED_SOURCE
    // 休市日不会有 bar；本函数只在交易日任务里调用，缺行且前一日有收盘视为停牌。
    const derivedSuspended = hasBar ? 0 : 1
    const isSuspended = external
      ? Number(existing.is_suspended)
      : input.mode === 'preopen'
        ? (existing ? Number(existing.is_suspended) : 0)
        : derivedSuspended
    const isSt = meta?.isSt || (existing ? Number(existing.is_st) === 1 : false)

    const statusWrite = await db.execute({
      sql: `INSERT INTO paper_market_status_daily
        (symbol_code, trade_date, is_suspended, is_st, status_source, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol_code, trade_date) DO UPDATE SET
          is_suspended = excluded.is_suspended, is_st = excluded.is_st,
          status_source = excluded.status_source, fetched_at = excluded.fetched_at
        WHERE paper_market_status_daily.status_source = ?`,
      args: [
        symbolCode, input.tradeDate, isSuspended, isSt ? 1 : 0, DERIVED_SOURCE, now, DERIVED_SOURCE,
      ],
    })
    if ((statusWrite.rowsAffected ?? 0) > 0) statuses += 1

    // 无前收或新股无涨跌停限制时不合成限价；结算会显式按缺价处理，避免猜一个价格。
    if (meta && !meta.noPriceLimit && prevClose && meta.board) {
      const limit = theoreticalLimitPrices(prevClose, meta.board, isSt)
      const limitWrite = await db.execute({
        sql: `INSERT INTO paper_limit_price_daily
          (symbol_code, trade_date, limit_up_cents, limit_down_cents, source_id, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol_code, trade_date) DO UPDATE SET
            limit_up_cents = excluded.limit_up_cents, limit_down_cents = excluded.limit_down_cents,
            source_id = excluded.source_id, fetched_at = excluded.fetched_at
          WHERE paper_limit_price_daily.source_id = ?`,
        args: [
          symbolCode, input.tradeDate, limit.limitUpCents, limit.limitDownCents,
          DERIVED_SOURCE, now, DERIVED_SOURCE,
        ],
      })
      if ((limitWrite.rowsAffected ?? 0) > 0) limits += 1
    }
  }

  return { symbols: symbols.length, statuses, limits }
}
