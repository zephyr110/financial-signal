/**
 * A 股与美股的交易时段（按各自的交易所时区判断，自动处理夏令时）。
 * 只负责“什么时候抓”，不碰行情与数据库；节假日不单独排除，
 * 休市日的快照会重复落在同一 trade_time 上，由写入方幂等覆盖。
 */

import type { TaskType } from './types'

const MINUTE_MS = 60_000

export type ASharePhase = 'preopen' | 'morning' | 'lunch' | 'afternoon' | 'postclose' | 'closed'

export interface MarketClock {
  /** 交易所当地时间 YYYY-MM-DD。 */
  date: string
  /** 0=周日 … 6=周六。 */
  weekday: number
  /** 当日分钟数。 */
  minutes: number
}

const SHANGHAI_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const NEW_YORK_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function clockOf(formatter: Intl.DateTimeFormat, now: Date): MarketClock {
  const parts = formatter.formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  const date = `${value('year')}-${value('month')}-${value('day')}`
  return {
    date,
    weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  }
}

export function shanghaiClock(now = new Date()): MarketClock {
  return clockOf(SHANGHAI_PARTS, now)
}

export function newYorkClock(now = new Date()): MarketClock {
  return clockOf(NEW_YORK_PARTS, now)
}

const PREOPEN = 9 * 60 + 15
const OPEN = 9 * 60 + 30
const MORNING_END = 11 * 60 + 30
const AFTERNOON_OPEN = 13 * 60
const CLOSE = 15 * 60
const POSTCLOSE_END = 15 * 60 + 30

/** 收盘链路（行情入库 → 驾驶舱分析）的触发时间。 */
const DAILY_CLOSE = 16 * 60 + 10

export function aSharePhase(now = new Date()): ASharePhase {
  const { weekday, minutes } = shanghaiClock(now)
  if (weekday === 0 || weekday === 6) return 'closed'
  if (minutes >= PREOPEN && minutes < OPEN) return 'preopen'
  if (minutes >= OPEN && minutes < MORNING_END) return 'morning'
  if (minutes >= MORNING_END && minutes < AFTERNOON_OPEN) return 'lunch'
  if (minutes >= AFTERNOON_OPEN && minutes < CLOSE) return 'afternoon'
  if (minutes >= CLOSE && minutes < POSTCLOSE_END) return 'postclose'
  return 'closed'
}

const US_OPEN = 9 * 60 + 30
/** 收盘后多抓 20 分钟，等延迟行情追上收盘价。 */
const US_GRACE_END = 16 * 60 + 20

export function usSessionActive(now = new Date()): boolean {
  const { weekday, minutes } = newYorkClock(now)
  return weekday >= 1 && weekday <= 5 && minutes >= US_OPEN && minutes < US_GRACE_END
}

const QUOTE_ACTIVE_MS = 1 * MINUTE_MS
const QUOTE_POSTCLOSE_MS = 5 * MINUTE_MS
const OVERSEAS_US_MS = 15 * MINUTE_MS
const OVERSEAS_A_SHARE_MS = 30 * MINUTE_MS
const OVERSEAS_IDLE_MS = 60 * MINUTE_MS

export interface LivePlan {
  phase: ASharePhase
  usActive: boolean
  /** A 股快照最小间隔；null 表示当前时段不抓。 */
  quoteIntervalMs: number | null
  overseasIntervalMs: number
}

export function livePlan(now = new Date()): LivePlan {
  const phase = aSharePhase(now)
  const usActive = usSessionActive(now)
  // 集合竞价没有连续成交价，09:30 开盘后才开始抓。
  const quoteIntervalMs = phase === 'morning' || phase === 'afternoon'
    ? QUOTE_ACTIVE_MS
    : phase === 'postclose'
      ? QUOTE_POSTCLOSE_MS
      : null
  const overseasIntervalMs = usActive
    ? OVERSEAS_US_MS
    : phase !== 'closed'
      ? OVERSEAS_A_SHARE_MS
      : OVERSEAS_IDLE_MS
  return { phase, usActive, quoteIntervalMs, overseasIntervalMs }
}

export function shouldQueueDailyClose(now = new Date()): boolean {
  const { weekday, minutes } = shanghaiClock(now)
  return weekday >= 1 && weekday <= 5 && minutes >= DAILY_CLOSE
}

/**
 * 模拟盘每日节奏（Asia/Shanghai）。补跑只补队列，不补成交：
 * 09:15 之后到达的盘前任务由影子执行自行拒绝。
 */
const PAPER_STEPS: Array<{ type: TaskType; at: number }> = [
  { type: 'paper_preopen_check', at: 8 * 60 + 30 },
  { type: 'paper_cutoff', at: 9 * 60 + 15 },
  { type: 'paper_settle', at: 16 * 60 + 20 },
  { type: 'paper_position_scan', at: 16 * 60 + 20 },
  { type: 'paper_reconcile', at: 16 * 60 + 30 },
  { type: 'paper_review_daily', at: 17 * 60 },
  { type: 'paper_evaluate_outcomes', at: 17 * 60 + 15 },
  { type: 'paper_agent_outcomes', at: 17 * 60 + 20 },
  { type: 'paper_cards_next_day', at: 17 * 60 + 30 },
  { type: 'paper_agent_plan', at: 17 * 60 + 35 },
]

const WEEKLY_REVIEW = 10 * 60

export interface PaperDueStep {
  type: TaskType
  tradeDate: string
}

/** 周复盘归属的最近一个周六（含当天）；周日与工作日都回退到本周六。 */
export function weeklyPeriodEnd(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const weekday = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() - (weekday === 6 ? 0 : (weekday + 1) % 7))
  return d.toISOString().slice(0, 10)
}

/** 周复盘按周期末幂等，工作日补跑同一周不会每天重算。 */
export function paperStepKey(step: PaperDueStep): string {
  const date = step.type === 'paper_review_weekly' ? weeklyPeriodEnd(step.tradeDate) : step.tradeDate
  return `live-paper:${step.type}:${date}`
}

export function paperStepsDue(now = new Date()): PaperDueStep[] {
  const { weekday, minutes, date } = shanghaiClock(now)
  // 周复盘按周期末周六幂等；周末/工作日都入队，才能在错过周六后补上同一周。
  const weekly: PaperDueStep[] = minutes >= WEEKLY_REVIEW ? [{ type: 'paper_review_weekly', tradeDate: date }] : []
  if (weekday === 6 || weekday === 0) return weekly
  return [
    ...PAPER_STEPS
      .filter((step) => minutes >= step.at)
      .map((step) => ({ type: step.type, tradeDate: date })),
    ...weekly,
  ]
}
