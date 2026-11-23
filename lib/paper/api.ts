import crypto from 'crypto'
import type { NextApiRequest, NextApiResponse } from 'next'
import { noStore, sendError } from '../cockpit/api'
import { isCalendarDate } from '../china-calendar'
import { getDb } from '../db'
import { stableStringify } from './policy'
import {
  getCurrentPaperExperiment,
  getPaperAccount,
  getPaperExperiment,
  getPaperExperimentPolicy,
  listPaperAccounts,
  PaperRepoError,
  type PaperAccountRow,
  type PaperExperimentRow,
} from './repo'
import type { PaperPolicy } from './types'

/** paper API 共用：解析当前实验/账户、统一错误码、请求哈希与响应封装。 */

export function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try { return JSON.parse(body) as Record<string, unknown> } catch { return {} }
  }
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

/** 日期合法性只保留一份定义，避免 API 放行日历模块不认的日期。 */
export function isTradeDate(value: unknown): value is string {
  return isCalendarDate(value)
}

export interface PaperApiContext {
  experiment: PaperExperimentRow
  account: PaperAccountRow
  policy: PaperPolicy
}

/** 默认取最近创建的 active 实验与它的主账户；query/body 可显式指定。 */
export async function resolvePaperContext(
  override: { experimentId?: string | null; accountId?: string | null } = {},
): Promise<PaperApiContext> {
  // 与页面同口径：paused/planned 也是“当前实验”，否则暂停后读接口会误报“尚未创建”。
  const experiment = override.experimentId
    ? await getPaperExperiment(override.experimentId)
    : await getCurrentPaperExperiment()
  if (!experiment) throw new PaperRepoError('NOT_FOUND', '尚未创建模拟盘实验')

  let account: PaperAccountRow | null = null
  if (override.accountId) {
    account = await getPaperAccount(override.accountId)
  } else {
    const accounts = await listPaperAccounts(experiment.id)
    account = accounts.find((a) => a.kind === 'user') ?? accounts[0] ?? null
  }
  if (!account || account.experimentId !== experiment.id) {
    throw new PaperRepoError('NOT_FOUND', '模拟盘账户不存在')
  }

  const { policy } = await getPaperExperimentPolicy(experiment.id)
  return { experiment, account, policy }
}

const ERROR_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  INVALID_STATE: 409,
  POLICY_MISMATCH: 409,
  IDEMPOTENCY_CONFLICT: 409,
  TOO_LATE: 409,
  DATA_QUALITY: 422,
  MISSING_PRICE: 422,
  RISK_REJECTED: 422,
}

/** 所有 paper 路由的兜底错误出口；风控拒绝带上违规明细。 */
export function sendPaperError(req: NextApiRequest, res: NextApiResponse, err: unknown): void {
  if (err instanceof PaperRepoError) {
    sendError(req, res, ERROR_STATUS[err.code] ?? 500, err.code, err.message, err.detail)
    return
  }
  console.error('[paper/api]', err instanceof Error ? err.message : err)
  sendError(req, res, 500, 'PAPER_FAILED', '纸面盘操作失败')
}

export function sendPaperData(res: NextApiResponse, status: number, data: unknown): void {
  noStore(res)
  res.status(status).json({
    data,
    meta: { asOf: new Date().toISOString(), sourceHealth: [] },
  })
}

/** 幂等请求哈希：同一语义请求在任何键序下得到同一哈希。 */
export function paperRequestHash(payload: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')
}

export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** 批量取标的最新名称（按 valid_from 最大的一条 SCD2 元数据）。 */
export async function loadPaperSymbolNames(symbols: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(symbols.filter(Boolean))]
  if (!unique.length) return {}
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT m.symbol_code, m.name FROM paper_symbol_meta m
          WHERE m.symbol_code IN (${unique.map(() => '?').join(',')})
            AND m.valid_from = (
              SELECT MAX(m2.valid_from) FROM paper_symbol_meta m2
              WHERE m2.symbol_code = m.symbol_code
            )`,
    args: unique,
  })
  const out: Record<string, string> = {}
  for (const row of r.rows) out[String(row.symbol_code)] = String(row.name)
  return out
}
