import { getActiveDbTarget, getDb, resolveDbTarget } from '../db'
import { readDbConfig } from '../db-config'
import { isChinaMarketOpen } from '../china-calendar'
import { refreshOverseasQuotes } from '../desk/overseas'
import {
  livePlan,
  paperStepKey,
  paperStepsDue,
  shanghaiClock,
  shouldQueueDailyClose,
  type PaperDueStep,
} from './market-hours'
import { refreshLiveQuotes } from './sources/live-quotes'
import { enqueueTask, scheduleTaskDrain } from './tasks'

/**
 * 进程内交易时段调度器：随 Next 服务启动，30 秒一次 tick。
 * 盘中抓 A 股快照，美股时段刷新外盘，16:10 排队收盘入库与驾驶舱分析。
 */

const TICK_MS = 30_000
const START_DELAY_MS = 5_000
const DAILY_RETRY_MS = 5 * 60_000
const SINGLETON_KEY = '__cockpitLiveScheduler'

export function liveSchedulerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NODE_ENV === 'test') return false
  if (env.NEXT_PHASE === 'phase-production-build') return false
  if (env.VERCEL) return false
  if (env.COCKPIT_DEMO === '1') return false
  if (env.COCKPIT_LIVE_SCHEDULER === '0') return false
  return true
}

async function localDbReady(): Promise<boolean> {
  // 已连接的库不会再热切；判断必须以实际连接为准，否则"保存新配置但未重启"的窗口内
  // 会把远端库当成本地库继续写，或反过来让本地任务停摆。
  const active = getActiveDbTarget()
  if (active) {
    if (!active.url.startsWith('file:')) return false
    await getDb()
    return true
  }
  // 尚未建连接时按配置预判；设置页选择的 Turso 也写在 db-config.json。
  let target
  try {
    target = resolveDbTarget(process.env, readDbConfig())
  } catch {
    return false
  }
  if (!target.url.startsWith('file:')) return false
  await getDb()
  return true
}

/**
 * 收盘任务用带日期的自定义幂等键：白天手动跑过 market_ingest 也不会让
 * 16:10 这次被判为重复；节假日则由任务自身回落到最近交易日。
 */
async function queueCloseAnalysis(tradeDate: string): Promise<void> {
  const ingest = await enqueueTask({
    type: 'market_ingest',
    params: {},
    idempotencyKey: `live-close:${tradeDate}`,
  })
  const desk = await enqueueTask({
    type: 'desk_tick',
    params: {},
    idempotencyKey: `live-desk:${tradeDate}`,
  })
  if ([ingest, desk].some((task) => task.status === 'queued' || task.status === 'running')) {
    scheduleTaskDrain()
  }
}

/** 入队成功不等于抓取成功；收盘任务后来失败时当天还要再排一次（enqueueTask 会把 failed 重置为 queued）。 */
async function closeTasksFailed(tradeDate: string): Promise<boolean> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT status FROM tasks WHERE idempotency_key IN (?, ?)',
    args: [`live-close:${tradeDate}`, `live-desk:${tradeDate}`],
  })
  return r.rows.some((row) => row.status === 'failed' || row.status === 'canceled')
}

const PAPER_RETRY_MS = 10 * 60_000
const PAPER_MAX_RETRIES = 3
/** 同一天同一步失败的退避状态；进程重启后重新计。 */
const paperRetry = new Map<string, { failures: number; nextAt: number }>()

/** 模拟盘节奏按日期幂等入队；失败任务 10 分钟后再试，最多 3 次。 */
async function queuePaperRhythm(steps: PaperDueStep[], at: Date): Promise<void> {
  if (!steps.length) return
  const db = await getDb()
  for (const step of steps) {
    const key = paperStepKey(step)
    const existing = await db.execute({
      sql: 'SELECT status FROM tasks WHERE idempotency_key = ? LIMIT 1',
      args: [key],
    })
    const status = existing.rows.length ? String(existing.rows[0].status) : ''
    if (status === 'succeeded' || status === 'queued' || status === 'running') continue
    if (status === 'failed' || status === 'canceled') {
      const state = paperRetry.get(key)
      if (state && (state.failures >= PAPER_MAX_RETRIES || at.getTime() < state.nextAt)) continue
      paperRetry.set(key, {
        failures: (state?.failures ?? 0) + 1,
        nextAt: at.getTime() + PAPER_RETRY_MS,
      })
    }
    const task = await enqueueTask({
      type: step.type,
      params: { tradeDate: step.tradeDate },
      idempotencyKey: key,
    })
    if (task.status === 'queued' || task.status === 'running') scheduleTaskDrain()
  }
}

export interface LiveSchedulerDeps {
  now?: () => Date
  dbReady?: () => boolean | Promise<boolean>
  isTradingDay?: (date: string) => Promise<boolean>
  refreshQuotes?: () => Promise<unknown>
  refreshOverseas?: () => Promise<unknown>
  queueClose?: (tradeDate: string) => Promise<unknown>
  closeTasksFailed?: (tradeDate: string) => Promise<boolean>
  queuePaper?: (steps: PaperDueStep[], at: Date) => Promise<unknown>
  log?: (message: string) => void
}

export interface LiveScheduler {
  tick: () => Promise<void>
  start: () => void
  stop: () => void
}

export function createLiveScheduler(overrides: LiveSchedulerDeps = {}): LiveScheduler {
  const now = overrides.now || (() => new Date())
  const dbReady = overrides.dbReady || localDbReady
  // 抓取函数自己吞掉单源失败并返回 warnings；一条都没写才算整轮失败，交给日志去重。
  const refreshQuotes = overrides.refreshQuotes || (async () => {
    const result = await refreshLiveQuotes()
    if (result.written === 0) throw new Error(result.warnings.join('；') || '没有可用的行情源')
    return result
  })
  const refreshOverseas = overrides.refreshOverseas || (async () => {
    const result = await refreshOverseasQuotes()
    if (result.written === 0) throw new Error(result.warnings.join('；') || '外盘行情为空')
    return result
  })
  const queueClose = overrides.queueClose || queueCloseAnalysis
  const closeFailed = overrides.closeTasksFailed || closeTasksFailed
  const queuePaper = overrides.queuePaper || queuePaperRhythm
  const tradingDayAt = overrides.isTradingDay
    || ((date: string) => isChinaMarketOpen(date, { allowNetwork: true }))
  const log = overrides.log || ((message: string) => console.log(`[live] ${message}`))

  const lastErrors: Record<string, string> = {}
  let lastQuoteAt = 0
  let lastOverseasAt = 0
  let dailyDoneDate = ''
  let dailyAttemptAt = 0
  let calendarDate = ''
  let calendarOpen = true
  let ticking = false
  let timer: ReturnType<typeof setInterval> | null = null
  let kick: ReturnType<typeof setTimeout> | null = null

  function report(kind: 'quote' | 'overseas' | 'daily' | 'paper' | 'calendar' | 'tick', err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (lastErrors[kind] === message) return
    lastErrors[kind] = message
    const label = kind === 'quote'
      ? 'A 股快照失败'
      : kind === 'overseas'
        ? '外盘快照失败'
        : kind === 'daily'
          ? '收盘分析入队失败'
          : kind === 'paper'
            ? '模拟盘任务入队失败'
            : kind === 'calendar'
              ? '交易日历检查失败'
              : '调度器异常'
    log(`${label}：${message}`)
  }

  /** 每个交易日只查一次；失败不缓存，下一轮重试。 */
  async function tradingDayOf(date: string): Promise<boolean> {
    if (date === calendarDate) return calendarOpen
    try {
      calendarOpen = await tradingDayAt(date)
      calendarDate = date
      delete lastErrors.calendar
      return calendarOpen
    } catch (err) {
      report('calendar', err)
      return false
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      if (!(await dbReady())) return
      const at = now()
      const stamp = at.getTime()
      const plan = livePlan(at)
      // 节假日与调休补班日不跑行情、收盘与模拟盘；外盘仍按自身时段刷新。
      const tradingDay = await tradingDayOf(shanghaiClock(at).date)

      if (tradingDay && plan.quoteIntervalMs != null && stamp - lastQuoteAt >= plan.quoteIntervalMs) {
        lastQuoteAt = stamp
        try {
          await refreshQuotes()
          delete lastErrors.quote
        } catch (err) {
          report('quote', err)
        }
      }

      if (stamp - lastOverseasAt >= plan.overseasIntervalMs) {
        lastOverseasAt = stamp
        try {
          await refreshOverseas()
          delete lastErrors.overseas
        } catch (err) {
          report('overseas', err)
        }
      }

      if (tradingDay && shouldQueueDailyClose(at)) {
        const tradeDate = shanghaiClock(at).date
        let retryAfterFailure = false
        if (dailyDoneDate === tradeDate && stamp - dailyAttemptAt >= DAILY_RETRY_MS) {
          // 查询失败不能中断本轮 tick（否则后面的模拟盘步骤也被跳过），下一轮再看。
          try {
            retryAfterFailure = await closeFailed(tradeDate)
          } catch (err) {
            report('daily', err)
          }
        }
        const due = dailyDoneDate !== tradeDate
          ? stamp - dailyAttemptAt >= DAILY_RETRY_MS
          : retryAfterFailure
        if (due) {
          dailyAttemptAt = stamp
          try {
            await queueClose(tradeDate)
            delete lastErrors.daily
            dailyDoneDate = tradeDate
            log(`${tradeDate} 收盘行情与分析已排队`)
          } catch (err) {
            report('daily', err)
          }
        }
      }

      // 周复盘是研究动作而非行情处理，周六休市也照常跑；其余步骤只在开市日入队。
      const paperSteps = paperStepsDue(at)
        .filter((step) => tradingDay || step.type === 'paper_review_weekly')
      if (paperSteps.length) {
        try {
          await queuePaper(paperSteps, at)
          delete lastErrors.paper
        } catch (err) {
          report('paper', err)
        }
      }
    } catch (err) {
      report('tick', err)
    } finally {
      ticking = false
    }
  }

  function unref(handle: unknown): void {
    (handle as { unref?: () => void }).unref?.()
  }

  function start(): void {
    if (timer) return
    kick = setTimeout(() => { void tick() }, START_DELAY_MS)
    unref(kick)
    timer = setInterval(() => { void tick() }, TICK_MS)
    unref(timer)
  }

  function stop(): void {
    if (kick) clearTimeout(kick)
    if (timer) clearInterval(timer)
    kick = null
    timer = null
  }

  return { tick, start, stop }
}

export function startLiveScheduler(): boolean {
  if (!liveSchedulerEnabled()) return false
  const holder = globalThis as Record<string, unknown>
  if (holder[SINGLETON_KEY]) return false
  const scheduler = createLiveScheduler()
  holder[SINGLETON_KEY] = scheduler
  scheduler.start()
  console.log('[live] 交易时段抓取已启动')
  return true
}

export function stopLiveScheduler(): void {
  const holder = globalThis as Record<string, unknown>
  const scheduler = holder[SINGLETON_KEY] as LiveScheduler | undefined
  if (!scheduler) return
  scheduler.stop()
  delete holder[SINGLETON_KEY]
}
