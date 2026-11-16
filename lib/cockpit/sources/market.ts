import { todayShanghai } from '../format'
import type { FetchLike } from './http'
import {
  deriveFreeCalendar,
  ingestFreeLimitPool,
  ingestFreeMarket,
  patchOverviewLimits,
  type FreeSourceId,
} from './free'
import { ingestAkshare } from './akshare'
import { hasTushareToken, ingestTushare } from './tushare'

/**
 * 行情入库编排：Tushare（T1）优先；无 token 或调用失败时整链降级到免费源，
 * 免费源也不可用时最后试 AKShare 侧车。免费源永远不覆盖同键的 T0/T1 行情。
 */

export type MarketSource = 'tushare' | FreeSourceId | 'akshare' | 'mixed'

export interface MarketIngestResult {
  tradeDate: string
  source: MarketSource
  fallbackFromTushare: boolean
  bars: number
  indices: number
  universe: number
  breadth: {
    up: number
    flat: number
    down: number
    limitUp: number
    limitDown: number
    limitUpDownAvailable: boolean
  } | null
  turnover: { value: number; changePct: number | null } | null
  limitUpDownAvailable: boolean
  limitPoolWritten: number
  warnings: string[]
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function ingestMarket(options: {
  tradeDate?: string
  prefer?: 'auto' | 'free'
  fetchImpl?: FetchLike
} = {}): Promise<MarketIngestResult> {
  const fetchImpl = options.fetchImpl || fetch
  const prefer = options.prefer === 'free' ? 'free' : 'auto'
  const warnings: string[] = []

  // 先用指数日线派生交易日历：Tushare 的 trade_cal 有 1 次/分钟限频，能绕开就绕开。
  let openDates: string[] | undefined
  try {
    openDates = await deriveFreeCalendar({
      anchorDate: options.tradeDate || todayShanghai(),
      fetchImpl,
    })
  } catch (err) {
    warnings.push(`免费交易日历不可用：${messageOf(err)}`)
  }

  let tushareFailed = false
  if (prefer === 'auto' && await hasTushareToken()) {
    try {
      const tushare = await ingestTushare({
        tradeDate: options.tradeDate,
        openDates,
        fetchImpl,
      })
      const extraWarnings: string[] = []
      let limitUpDownAvailable = tushare.limitUpDownAvailable
      let limitPoolWritten = 0
      // Tushare 的 limit_list_d 要 5000 分；缺权限时用东财涨停池补齐涨跌停计数。
      if (!tushare.limitUpDownAvailable) {
        const pool = await ingestFreeLimitPool({ tradeDate: tushare.tradeDate, fetchImpl })
        extraWarnings.push(...pool.warnings)
        limitPoolWritten = pool.written
        if (pool.available) {
          limitUpDownAvailable = true
          await patchOverviewLimits(tushare.tradeDate, {
            limitUp: pool.limitUp,
            limitDown: pool.limitDown,
          })
          tushare.breadth.limitUp = pool.limitUp
          tushare.breadth.limitDown = pool.limitDown
        }
      }
      return {
        tradeDate: tushare.tradeDate,
        source: 'tushare',
        fallbackFromTushare: false,
        bars: tushare.bars,
        indices: tushare.indices,
        universe: tushare.universe,
        breadth: { ...tushare.breadth, limitUpDownAvailable },
        turnover: tushare.turnover,
        limitUpDownAvailable,
        limitPoolWritten,
        warnings: [...tushare.warnings, ...warnings, ...extraWarnings],
      }
    } catch (err) {
      tushareFailed = true
      warnings.push(`Tushare 行情不可用：${messageOf(err).slice(0, 200)}；已切换免费源`)
    }
  }

  try {
    const free = await ingestFreeMarket({
      tradeDate: options.tradeDate,
      openDates,
      fetchImpl,
    })
    return {
      tradeDate: free.tradeDate,
      source: free.source,
      fallbackFromTushare: tushareFailed,
      bars: free.bars,
      indices: free.indices,
      universe: free.universe,
      breadth: free.breadth,
      turnover: free.turnover,
      limitUpDownAvailable: free.limitUpDownAvailable,
      limitPoolWritten: free.limitPoolWritten,
      warnings: [...warnings, ...free.warnings],
    }
  } catch (err) {
    const freeError = err instanceof Error ? err : new Error(String(err))
    try {
      const fallback = await ingestAkshare({ tradeDate: options.tradeDate, fetchImpl })
      if (fallback.configured) {
        return {
          tradeDate: fallback.tradeDate,
          source: 'akshare',
          fallbackFromTushare: tushareFailed,
          bars: fallback.insertedBars,
          indices: 0,
          universe: fallback.codes,
          breadth: null,
          turnover: null,
          limitUpDownAvailable: fallback.limitPoolWritten > 0,
          limitPoolWritten: fallback.limitPoolWritten,
          warnings: [
            ...warnings,
            `免费行情链路不可用：${freeError.message}`,
            ...fallback.warnings,
          ],
        }
      }
    } catch (fallbackError) {
      warnings.push(`AKShare 侧车兜底失败：${messageOf(fallbackError)}`)
    }
    throw new Error(`免费行情源均不可用：${freeError.message}`)
  }
}
