import { describe, it, expect, vi } from 'vitest'
import { createLiveScheduler, liveSchedulerEnabled } from '../lib/cockpit/live-scheduler'

/**
 * 调度器只做节流与触发：注入时钟和副作用，验证盘中每分钟、
 * 午休停抓、收盘后 5 分钟、16:10 每日只入队一次，失败 5 分钟后重试。
 */

function build(start: string) {
  const clock = { now: new Date(start) }
  const refreshQuotes = vi.fn(async () => ({ written: 1 }))
  const refreshOverseas = vi.fn(async () => ({ written: 1 }))
  const queueClose = vi.fn(async () => undefined)
  const scheduler = createLiveScheduler({
    now: () => clock.now,
    dbReady: () => true,
    refreshQuotes,
    refreshOverseas,
    queueClose,
    log: () => {},
  })
  return { clock, refreshQuotes, refreshOverseas, queueClose, scheduler }
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

  it('入队失败 5 分钟后重试，成功后不再重复', async () => {
    const clock = { now: new Date('2026-11-16T08:10:00Z') }
    const queueClose = vi.fn()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(undefined)
    const scheduler = createLiveScheduler({
      now: () => clock.now,
      dbReady: () => true,
      refreshQuotes: async () => undefined,
      refreshOverseas: async () => undefined,
      queueClose,
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

  it('数据库不可用时整轮跳过', async () => {
    const refreshQuotes = vi.fn(async () => undefined)
    const queueClose = vi.fn(async () => undefined)
    const scheduler = createLiveScheduler({
      now: () => new Date('2026-11-16T08:10:00Z'),
      dbReady: () => false,
      refreshQuotes,
      refreshOverseas: async () => undefined,
      queueClose,
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
      refreshQuotes: async () => undefined,
      refreshOverseas: async () => undefined,
      queueClose: async () => undefined,
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
      refreshQuotes,
      refreshOverseas: async () => undefined,
      queueClose: async () => undefined,
      log: () => {},
    })

    await expect(scheduler.tick()).resolves.toBeUndefined()
    clock.now = new Date('2026-11-16T02:01:01Z')
    await scheduler.tick()
    expect(refreshQuotes).toHaveBeenCalledTimes(2)
  })
})
