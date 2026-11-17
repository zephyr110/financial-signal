import { getDb, resolveDbTarget } from '../db'
import { readDbConfig } from '../db-config'
import { refreshOverseasQuotes } from '../desk/overseas'
import { livePlan, shanghaiClock, shouldQueueDailyClose } from './market-hours'
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
  // 设置页选择的 Turso 也写在 db-config.json，只看环境变量会把它误当本地库。
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

export interface LiveSchedulerDeps {
  now?: () => Date
  dbReady?: () => boolean | Promise<boolean>
  refreshQuotes?: () => Promise<unknown>
  refreshOverseas?: () => Promise<unknown>
  queueClose?: (tradeDate: string) => Promise<unknown>
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
  const log = overrides.log || ((message: string) => console.log(`[live] ${message}`))

  const lastErrors: Record<string, string> = {}
  let lastQuoteAt = 0
  let lastOverseasAt = 0
  let dailyDoneDate = ''
  let dailyAttemptAt = 0
  let ticking = false
  let timer: ReturnType<typeof setInterval> | null = null
  let kick: ReturnType<typeof setTimeout> | null = null

  function report(kind: 'quote' | 'overseas' | 'daily' | 'tick', err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (lastErrors[kind] === message) return
    lastErrors[kind] = message
    const label = kind === 'quote'
      ? 'A 股快照失败'
      : kind === 'overseas'
        ? '外盘快照失败'
        : kind === 'daily'
          ? '收盘分析入队失败'
          : '调度器异常'
    log(`${label}：${message}`)
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      if (!(await dbReady())) return
      const at = now()
      const stamp = at.getTime()
      const plan = livePlan(at)

      if (plan.quoteIntervalMs != null && stamp - lastQuoteAt >= plan.quoteIntervalMs) {
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

      if (shouldQueueDailyClose(at)) {
        const tradeDate = shanghaiClock(at).date
        const due = dailyDoneDate !== tradeDate && stamp - dailyAttemptAt >= DAILY_RETRY_MS
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
