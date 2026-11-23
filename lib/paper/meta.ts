import crypto from 'crypto'
import { getDb } from '../db'
import { researchCodes } from '../cockpit/universe'
import { addCalendarDays } from './calendar'
import { lotRuleFor, priceLimitBpFor, resolveBoard } from './market'
import { stableStringify } from './policy'
import type { PaperBoard } from './types'

/**
 * 标的元数据同步：paper_symbol_meta 是 SCD2，下游确认与结算都按 valid_from/valid_to 取值。
 * 名称/行业从 symbols 表来，上市日暂用最早一根日线近似（免费源没有更可靠的字段）。
 */

const BOARD_EXCHANGE: Record<PaperBoard, 'SH' | 'SZ' | 'BJ'> = {
  main_sh: 'SH',
  star: 'SH',
  main_sz: 'SZ',
  chinext: 'SZ',
  bse: 'BJ',
}

export interface PaperMetaSyncResult {
  symbols: string[]
  inserted: number
  closed: number
  unchanged: number
  skipped: Array<{ symbolCode: string; reason: string }>
}

const str = (v: unknown): string => (v == null ? '' : String(v))

function isStName(name: string): boolean {
  return /st/i.test(name)
}

/** 当前宇宙 = 实验池 ∪ 各账户持仓；实验池为空时回落到研究池（自选 ∪ 持仓）。 */
export async function loadPaperUniverse(input: {
  experimentId?: string | null
  limit?: number
} = {}): Promise<{ symbols: string[]; holdings: Set<string>; pooled: string[] }> {
  const db = await getDb()
  const limit = input.limit ?? 60
  const pooled: string[] = []
  if (input.experimentId) {
    const r = await db.execute({
      sql: `SELECT symbol_code FROM paper_universe
            WHERE experiment_id = ? AND removed_at IS NULL ORDER BY added_at, symbol_code`,
      args: [input.experimentId],
    })
    pooled.push(...r.rows.map((row) => str(row.symbol_code)).filter(Boolean))
  }
  const research = await researchCodes(limit)
  const holdingsR = await db.execute({
    sql: `SELECT DISTINCT p.symbol_code FROM paper_positions p
          JOIN paper_accounts a ON a.id = p.account_id
          WHERE p.total_qty > 0 AND a.status = 'active'`,
    args: [],
  })
  const holdings = new Set<string>(
    holdingsR.rows.map((row) => str(row.symbol_code)),
  )
  const symbols: string[] = [...new Set<string>([...pooled, ...research, ...holdings])].slice(0, limit)
  return { symbols, holdings, pooled }
}

export async function syncPaperUniverse(input: {
  experimentId: string
  now?: string
}): Promise<{ added: number }> {
  const db = await getDb()
  const now = input.now ?? new Date().toISOString()
  const { symbols, holdings } = await loadPaperUniverse({ experimentId: input.experimentId })
  let added = 0
  for (const symbolCode of symbols) {
    const source = holdings.has(symbolCode) ? 'holding' : 'system'
    const r = await db.execute({
      sql: `INSERT INTO paper_universe (experiment_id, symbol_code, source, reason, added_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(experiment_id, symbol_code) DO UPDATE SET
              removed_at = NULL,
              source = CASE WHEN excluded.source = 'holding' THEN 'holding' ELSE paper_universe.source END`,
      args: [input.experimentId, symbolCode, source, holdings.has(symbolCode) ? '当前持仓' : '研究池', now],
    })
    if ((r.rowsAffected ?? 0) > 0) added += 1
  }
  return { added }
}

/** 写入/更新当日元数据；内容未变只保证有一行，不产生新的 SCD2 版本。 */
export async function syncPaperSymbolMeta(input: {
  tradeDate: string
  experimentId?: string | null
}): Promise<PaperMetaSyncResult> {
  const db = await getDb()
  const { symbols } = await loadPaperUniverse({ experimentId: input.experimentId })
  const result: PaperMetaSyncResult = {
    symbols: [],
    inserted: 0,
    closed: 0,
    unchanged: 0,
    skipped: [],
  }

  for (const symbolCode of symbols) {
    const board = resolveBoard(symbolCode)
    if (!board) {
      result.skipped.push({ symbolCode, reason: '无法识别板别' })
      continue
    }
    const [symbolR, barR, existingR] = await Promise.all([
      db.execute({
        sql: 'SELECT name, industry_l1 FROM symbols WHERE code = ?',
        args: [symbolCode],
      }),
      db.execute({
        sql: `SELECT MIN(trade_date) AS first_date FROM market_bars
              WHERE code = ? AND adjust_type = 'raw'`,
        args: [symbolCode],
      }),
      db.execute({
        sql: `SELECT * FROM paper_symbol_meta
              WHERE symbol_code = ? AND valid_to IS NULL
              ORDER BY valid_from DESC LIMIT 1`,
        args: [symbolCode],
      }),
    ])
    if (!symbolR.rows.length) {
      result.skipped.push({ symbolCode, reason: '缺少 symbols 元数据' })
      continue
    }
    const symbol = symbolR.rows[0]
    const name = str(symbol.name)
    if (!name) {
      result.skipped.push({ symbolCode, reason: '名称为空' })
      continue
    }
    const isSt = isStName(name)
    const meta = {
      name,
      exchange: BOARD_EXCHANGE[board],
      board,
      industryCode: null as string | null,
      industryName: str(symbol.industry_l1) || null,
      isSt,
      lotSize: lotRuleFor(board).minQty,
      limitPctBp: priceLimitBpFor(board, isSt),
      noPriceLimit: false,
      listedAt: str(barR.rows[0]?.first_date) || null,
      delistedAt: null as string | null,
      sourceId: 'symbols',
    }
    const metaHash = crypto.createHash('sha256').update(stableStringify(meta)).digest('hex')
    const existing = existingR.rows[0]
    result.symbols.push(symbolCode)

    if (existing && str(existing.meta_hash) === metaHash) {
      result.unchanged += 1
      continue
    }
    if (existing) {
      await db.execute({
        sql: `UPDATE paper_symbol_meta SET valid_to = ?
              WHERE symbol_code = ? AND valid_from = ? AND valid_to IS NULL`,
        args: [addCalendarDays(input.tradeDate, -1), symbolCode, str(existing.valid_from)],
      })
      result.closed += 1
    }
    await db.execute({
      sql: `INSERT INTO paper_symbol_meta
        (symbol_code, valid_from, valid_to, name, exchange, board, industry_code, industry_name,
         is_st, lot_size, limit_pct_bp, no_price_limit, listed_at, delisted_at, source_id, meta_hash)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol_code, valid_from) DO UPDATE SET
          name = excluded.name, exchange = excluded.exchange, board = excluded.board,
          industry_code = excluded.industry_code, industry_name = excluded.industry_name,
          is_st = excluded.is_st, lot_size = excluded.lot_size,
          limit_pct_bp = excluded.limit_pct_bp, no_price_limit = excluded.no_price_limit,
          listed_at = excluded.listed_at, delisted_at = excluded.delisted_at,
          source_id = excluded.source_id, meta_hash = excluded.meta_hash`,
      args: [
        symbolCode, input.tradeDate, meta.name, meta.exchange, meta.board, meta.industryCode,
        meta.industryName, meta.isSt ? 1 : 0, meta.lotSize, meta.limitPctBp,
        meta.noPriceLimit ? 1 : 0, meta.listedAt, meta.delistedAt, meta.sourceId, metaHash,
      ],
    })
    result.inserted += 1
  }
  return result
}
