import { describe, it, expect, vi } from 'vitest'
import { createLiveScheduler, liveSchedulerEnabled } from '../lib/cockpit/live-scheduler'
import type { PaperDueStep } from '../lib/cockpit/market-hours'

/**
 * 调度器只做节流与触发：注入时钟和副作用，验证盘中每分钟、
 * 午休停抓、收盘后 5 分钟、16:10 每日只入队一次，失败 5 分钟后重试。
 */

function build(start: string, tradingDay = true) {
  const clock = { now: new Date(start) }
  const isTradingDay = vi.fn(async (_date: string) => tradingDay)
  const refreshQuotes = vi.fn(async () => ({ written: 1 }))
  const refreshOverseas = vi.fn(async () => ({ written: 1 }))
  const queueClose = vi.fn(async () => undefined)
  const closeTasksFailed = vi.fn(async (_tradeDate: string) => false)
  const queuePaper = vi.fn(async (_steps: PaperDueStep[], _at: Date) => undefined)
  const queueNews = vi.fn(async (_at: Date) => undefined)
  const scheduler = createLiveScheduler({
    now: () => clock.now,
    dbReady: () => true,
    isTradingDay,
    refreshQuotes,
    refreshOverseas,
    queueClose,
    closeTasksFailed,
    queuePaper,
    queueNews,
    log: () => {},
  })
  return { clock, isTradingDay, refreshQuotes, refreshOverseas, queueClose, closeTasksFailed, queuePaper, queueNews, scheduler }
}

describe('交易时段调度器', () => {
  it('开关默认开启，测试/构建/Vercel/演示可关闭', () => {
    expect(liveSchedulerEnabled({})).toBe(true)
    expect(liveSchedulerEnabled({ NODE_ENV: 'test' })).toBe(false)
    expect(liveSchedulerEnabled({ NEXT_PHASE: 'phase-production-build' })).toBe(false)
    expect(liveSchedulerEnabled({ VERCEL: '1' })).toBe(false)
    expect(liveSchedulerEnabled({ COCKPIT_DEMO: '1' })).toBe(false)
    expect(liveSchedulerEnabled({ COCKPIT_LIVE_SCHEDULER: '0' })).toBe(false)
  })

  it('盘中每分钟抓一次，午休和收盘后按各自间隔', async () => {
    const { clock, refreshQuotes, refreshOverseas, queueClose, scheduler } = build('2026-11-16T02:00:00Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(1)
    expect(refreshOverseas).toHaveBeenCalledTimes(1)
    expect(queueClose).not.toHaveBeenCalled()

    clock.now = new Date('2026-11-16T02:00:30Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(1)

    clock.now = new Date('2026-11-16T02:01:01Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(2)

    clock.now = new Date('2026-11-16T04:00:00Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(2)

    clock.now = new Date('2026-11-16T07:05:00Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(3)

    clock.now = new Date('2026-11-16T07:06:00Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(3)
  })

  it('08:30 前不排模拟盘任务，之后按当日节奏入队', async () => {
    const early = build('2026-11-16T00:29:00Z')
    await early.scheduler.tick()
    expect(early.queuePaper).not.toHaveBeenCalled()

    const { clock, queuePaper, scheduler } = build('2026-11-16T00:30:00Z')
    await scheduler.tick()
    expect(queuePaper).toHaveBeenCalledTimes(1)
    expect(queuePaper.mock.calls[0][0]).toEqual([
      { type: 'paper_preopen_check', tradeDate: '2026-11-16' },
    ])

    clock.now = new Date('2026-11-16T09:30:00Z')
    await scheduler.tick()
    expect(queuePaper).toHaveBeenCalledTimes(2)
    // 周复盘是补跑型任务，到达时点后每天都排，排在当日节奏之后。
    expect(queuePaper.mock.calls[1][0]).toEqual(expect.arrayContaining([
      { type: 'paper_cards_next_day', tradeDate: '2026-11-16' },
      { type: 'paper_review_weekly', tradeDate: '2026-11-16' },
    ]))
  })

  it('休息日不跑 A 股行情、收盘与模拟盘，外盘照常', async () => {
    const { clock, isTradingDay, refreshQuotes, refreshOverseas, queueClose, queuePaper, scheduler } = build(
      '2026-11-16T02:00:00Z',
      false,
    )
    await scheduler.tick()
    expect(isTradingDay).toHaveBeenCalledWith('2026-11-16')
    expect(refreshQuotes).not.toHaveBeenCalled()
    expect(refreshOverseas).toHaveBeenCalledTimes(1)
    expect(queueClose).not.toHaveBeenCalled()
    // 休市日不排盘中步骤，但周复盘仍要补跑最近一个周六。
    expect(queuePaper).toHaveBeenCalledTimes(1)
    expect(queuePaper.mock.calls[0][0]).toEqual([
      { type: 'paper_review_weekly', tradeDate: '2026-11-16' },
    ])

    clock.now = new Date('2026-11-16T08:10:00Z')
    await scheduler.tick()
    expect(queueClose).not.toHaveBeenCalled()
    expect(queuePaper).toHaveBeenCalledTimes(2)
  })

  it('周六休市仍排周复盘，不跑行情', async () => {
    const { refreshQuotes, queuePaper, scheduler } = build('2026-11-14T02:00:00Z', false)
    await scheduler.tick()
    expect(refreshQuotes).not.toHaveBeenCalled()
    expect(queuePaper).toHaveBeenCalledTimes(1)
    expect(queuePaper.mock.calls[0][0]).toEqual([
      { type: 'paper_review_weekly', tradeDate: '2026-11-14' },
    ])
  })

  it('交易日历检查失败时跳过行情，下一轮恢复', async () => {
    const clock = { now: new Date('2026-11-16T02:00:00Z') }
    const isTradingDay = vi.fn()
      .mockRejectedValueOnce(new Error('calendar locked'))
      .mockResolvedValue(true)
    const refreshQuotes = vi.fn(async () => undefined)
    const log = vi.fn()
    const scheduler = createLiveScheduler({
      now: () => clock.now,
      dbReady: () => true,
      isTradingDay,
      refreshQuotes,
      refreshOverseas: async () => undefined,
      queueClose: async () => undefined,
      queuePaper: async () => undefined,
      queueNews: async () => undefined,
      log,
    })

    await scheduler.tick()
    expect(refreshQuotes).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('交易日历检查失败：calendar locked')

    clock.now = new Date('2026-11-16T02:01:01Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(1)
  })

  it('16:10 每个交易日只入队一次，次日重新入队', async () => {
    const { clock, queueClose, scheduler } = build('2026-11-16T08:10:00Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(1)
    expect(queueClose).toHaveBeenCalledWith('2026-11-16')

    clock.now = new Date('2026-11-16T09:00:00Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(1)

    clock.now = new Date('2026-11-17T08:11:00Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(2)
    expect(queueClose).toHaveBeenLastCalledWith('2026-11-17')
  })

  it('新闻管线首次入队，之后每 30 分钟一次', async () => {
    const { clock, queueNews, scheduler } = build('2026-11-16T00:00:00Z', false)
    await scheduler.tick()
    expect(queueNews).toHaveBeenCalledTimes(1)
    expect(queueNews.mock.calls[0][0]).toEqual(new Date('2026-11-16T00:00:00Z'))

    clock.now = new Date('2026-11-16T00:29:59Z')
    await scheduler.tick()
    expect(queueNews).toHaveBeenCalledTimes(1)

    clock.now = new Date('2026-11-16T00:30:00Z')
    await scheduler.tick()
    expect(queueNews).toHaveBeenCalledTimes(2)
  })

  it('新闻入队失败不影响本轮行情抓取', async () => {
    const log = vi.fn()
    const refreshQuotes = vi.fn(async () => undefined)
    const scheduler = createLiveScheduler({
      now: () => new Date('2026-11-16T02:00:00Z'),
      dbReady: () => true,
      isTradingDay: async () => true,
      refreshQuotes,
      refreshOverseas: async () => undefined,
      queueClose: async () => undefined,
      queuePaper: async () => undefined,
      queueNews: async () => { throw new Error('database is locked') },
      log,
    })

    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('新闻管线入队失败：database is locked')
  })

  it('桌面模式不排新闻管线，避免与 Electron 调度器重复', async () => {
    const queueNews = vi.fn(async () => undefined)
    const scheduler = createLiveScheduler({
      now: () => new Date('2026-11-16T02:00:00Z'),
      dbReady: () => true,
      isTradingDay: async () => true,
      refreshQuotes: async () => undefined,
      refreshOverseas: async () => undefined,
      queueClose: async () => undefined,
      queuePaper: async () => undefined,
      queueNews,
      pipelineAutomation: false,
      log: () => {},
    })

    await scheduler.tick()
    expect(queueNews).not.toHaveBeenCalled()
  })

  it('入队失败 5 分钟后重试，成功后不再重复', async () => {
    const clock = { now: new Date('2026-11-16T08:10:00Z') }
    const queueClose = vi.fn()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(undefined)
    const scheduler = createLiveScheduler({
      now: () => clock.now,
      dbReady: () => true,
      isTradingDay: async () => true,
      refreshQuotes: async () => undefined,
      refreshOverseas: async () => undefined,
      queueClose,
      closeTasksFailed: async () => false,
      queuePaper: async () => undefined,
      queueNews: async () => undefined,
      log: () => {},
    })

    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(1)

    clock.now = new Date('2026-11-16T08:12:00Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(1)

    clock.now = new Date('2026-11-16T08:15:01Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(2)

    clock.now = new Date('2026-11-16T09:00:00Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(2)
  })

  it('收盘任务入队后失败，5 分钟后当天重新入队', async () => {
    const clock = { now: new Date('2026-11-16T08:10:00Z') }
    const queueClose = vi.fn(async () => undefined)
    let failed = false
    const closeTasksFailed = vi.fn(async (_tradeDate: string) => failed)
    const scheduler = createLiveScheduler({
      now: () => clock.now,
      dbReady: () => true,
      isTradingDay: async () => true,
      refreshQuotes: async () => undefined,
      refreshOverseas: async () => undefined,
      queueClose,
      closeTasksFailed,
      queuePaper: async () => undefined,
      queueNews: async () => undefined,
      log: () => {},
    })

    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(1)

    failed = true
    clock.now = new Date('2026-11-16T08:12:00Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(1)

    clock.now = new Date('2026-11-16T08:15:01Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(2)

    failed = false
    clock.now = new Date('2026-11-16T08:20:02Z')
    await scheduler.tick()
    expect(queueClose).toHaveBeenCalledTimes(2)
  })

  it('数据库不可用时整轮跳过', async () => {
    const refreshQuotes = vi.fn(async () => undefined)
    const queueClose = vi.fn(async () => undefined)
    const scheduler = createLiveScheduler({
      now: () => new Date('2026-11-16T08:10:00Z'),
      dbReady: () => false,
      isTradingDay: async () => true,
      refreshQuotes,
      refreshOverseas: async () => undefined,
      queueClose,
      queuePaper: async () => undefined,
      queueNews: async () => undefined,
      log: () => {},
    })
    await scheduler.tick()
    expect(refreshQuotes).not.toHaveBeenCalled()
    expect(queueClose).not.toHaveBeenCalled()
  })

  it('数据库初始化异常只记一次日志，不会产生未处理拒绝', async () => {
    const log = vi.fn()
    const scheduler = createLiveScheduler({
      now: () => new Date('2026-11-16T02:00:00Z'),
      dbReady: () => { throw new Error('database is locked') },
      isTradingDay: async () => true,
      refreshQuotes: async () => undefined,
      refreshOverseas: async () => undefined,
      queueClose: async () => undefined,
      queuePaper: async () => undefined,
      queueNews: async () => undefined,
      log,
    })
    await expect(scheduler.tick()).resolves.toBeUndefined()
    await scheduler.tick()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('调度器异常：database is locked')
  })

  it('抓取失败不抛出，下一轮照常执行', async () => {
    const refreshQuotes = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const clock = { now: new Date('2026-11-16T02:00:00Z') }
    const scheduler = createLiveScheduler({
      now: () => clock.now,
      dbReady: () => true,
      isTradingDay: async () => true,
      refreshQuotes,
      refreshOverseas: async () => undefined,
      queueClose: async () => undefined,
      queuePaper: async () => undefined,
      queueNews: async () => undefined,
      log: () => {},
    })

    await expect(scheduler.tick()).resolves.toBeUndefined()
    clock.now = new Date('2026-11-16T02:01:01Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(2)
  })
})
