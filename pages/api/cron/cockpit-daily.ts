import type { NextApiRequest, NextApiResponse } from 'next'
import { assertCronAuth } from '../../../lib/cronAuth'
import { getDb } from '../../../lib/db'
import { todayShanghai } from '../../../lib/cockpit/format'
import {
  drainTasks,
  enqueueTask,
  getTask,
  scheduleTaskDrain,
} from '../../../lib/cockpit/tasks'
import { ensureTradingCalendar, hasTushareToken } from '../../../lib/cockpit/sources/tushare'

/**
 * 每日收盘链路：行情入库 → 官方公告/政策 → 校对发布简报。
 * GET /api/cron/cockpit-daily
 *
 * 节流不靠调度频率：每 30 分钟被调用也只是查一次交易日历与报告表。
 * - 收盘后（上海 16:10 起）目标是当天，否则是最近一个开市日；
 * - 目标日来自 trading_calendar，法定节假日与无 token 时直接跳过；
 * - 同一目标日已有已发布简报 → 跳过；任务成功过 → 跳过。
 * ?force=1 强制重跑，?tradeDate=YYYY-MM-DD 指定日期，?drain=1 同步执行（本地/测试）。
 */

const CLOSE_MINUTES = 16 * 60 + 10

function shanghaiClock(now = new Date()): { date: string; weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return {
    date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now),
    weekday: get('weekday'),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

function previousWeekday(date: string): string {
  const day = new Date(`${date}T12:00:00+08:00`)
  do {
    day.setUTCDate(day.getUTCDate() - 1)
  } while (day.getUTCDay() === 0 || day.getUTCDay() === 6)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(day)
}

export function resolveCockpitDailyTarget(
  now = new Date(),
  openDates?: string[],
): { tradeDate: string; afterClose: boolean } | null {
  const { date, weekday, minutes } = shanghaiClock(now)
  if (openDates) {
    const eligible = [...openDates]
      .filter((day) => day < date || (day === date && minutes >= CLOSE_MINUTES))
      .sort()
    if (eligible.length === 0) return null
    const tradeDate = eligible[eligible.length - 1]
    return { tradeDate, afterClose: tradeDate === date }
  }
  // 无日历时保留旧的周末启发式，供纯函数调用/测试使用。
  const weekdaySession = weekday !== 'Sat' && weekday !== 'Sun'
  if (weekdaySession && minutes >= CLOSE_MINUTES) return { tradeDate: date, afterClose: true }
  return { tradeDate: previousWeekday(date), afterClose: false }
}

async function hasPublishedReport(tradeDate: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT id FROM reports
          WHERE kind = 'daily_brief' AND subject_code = '' AND trade_date = ? AND status = 'published'
          LIMIT 1`,
    args: [tradeDate],
  })
  return Boolean(res.rows[0])
}

function queryString(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : ''
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await assertCronAuth(req, res)) return
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const force = queryString(req.query.force) === '1'
    const drain = queryString(req.query.drain) === '1'
    const explicitDate = queryString(req.query.tradeDate)
    if (explicitDate && !/^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) {
      return res.status(400).json({ error: 'tradeDate 格式应为 YYYY-MM-DD' })
    }
    if (!await hasTushareToken()) {
      return res.status(200).json({ ok: true, skipped: 'no_tushare_token' })
    }

    let openDates: string[]
    try {
      const calendar = await ensureTradingCalendar({ anchorDate: explicitDate || todayShanghai() })
      openDates = calendar.openDates
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[cron/cockpit-daily] calendar', message)
      return res.status(200).json({ ok: true, skipped: 'calendar_unavailable', message })
    }

    if (explicitDate && !openDates.includes(explicitDate)) {
      return res.status(200).json({ ok: true, skipped: 'not_trading_day', tradeDate: explicitDate })
    }
    const target = explicitDate
      ? { tradeDate: explicitDate, afterClose: true }
      : resolveCockpitDailyTarget(new Date(), openDates)
    if (!target) {
      return res.status(200).json({ ok: true, skipped: 'no_open_day' })
    }

    if (!force && !explicitDate && await hasPublishedReport(target.tradeDate)) {
      return res.status(200).json({ ok: true, skipped: 'already_built', tradeDate: target.tradeDate })
    }

    const task = await enqueueTask({
      type: 'daily_close',
      params: force ? { tradeDate: target.tradeDate, force: true } : { tradeDate: target.tradeDate },
      idempotencyKey: `cockpit-daily:${target.tradeDate}`,
    })
    if (task.status !== 'queued') {
      if (drain && task.status === 'running') await drainTasks()
      else if (task.status === 'running') scheduleTaskDrain()
      return res.status(200).json({
        ok: true,
        skipped: 'task_exists',
        tradeDate: target.tradeDate,
        task: drain ? await getTask(task.id) : task,
      })
    }

    if (drain) {
      await drainTasks()
      return res.status(200).json({
        ok: true,
        tradeDate: target.tradeDate,
        drain: true,
        task: await getTask(task.id),
      })
    }

    scheduleTaskDrain()
    return res.status(202).json({ ok: true, tradeDate: target.tradeDate, task })
  } catch (error) {
    console.error('[cron/cockpit-daily]', error instanceof Error ? error.message : error)
    return res.status(500).json({ error: 'Cockpit daily close failed' })
  }
}
