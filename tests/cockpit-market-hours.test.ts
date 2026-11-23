import { describe, it, expect } from 'vitest'
import {
  aSharePhase,
  livePlan,
  newYorkClock,
  paperStepsDue,
  shanghaiClock,
  shouldQueueDailyClose,
  usSessionActive,
} from '../lib/cockpit/market-hours'

/**
 * 时段判定全部用 UTC 时刻构造，覆盖 A 股午休、收盘后，
 * 以及美股的夏令时（EDT）与冬令时（EST）。
 */

describe('market hours', () => {
  it('按上海时间划分 A 股时段', () => {
    expect(aSharePhase(new Date('2026-11-16T01:14:00Z'))).toBe('closed')
    expect(aSharePhase(new Date('2026-11-16T01:15:00Z'))).toBe('preopen')
    expect(aSharePhase(new Date('2026-11-16T01:29:00Z'))).toBe('preopen')
    expect(aSharePhase(new Date('2026-11-16T01:30:00Z'))).toBe('morning')
    expect(aSharePhase(new Date('2026-11-16T03:29:00Z'))).toBe('morning')
    expect(aSharePhase(new Date('2026-11-16T03:30:00Z'))).toBe('lunch')
    expect(aSharePhase(new Date('2026-11-16T05:00:00Z'))).toBe('afternoon')
    expect(aSharePhase(new Date('2026-11-16T07:00:00Z'))).toBe('postclose')
    expect(aSharePhase(new Date('2026-11-16T07:30:00Z'))).toBe('closed')
  })

  it('周末不抓 A 股行情', () => {
    expect(aSharePhase(new Date('2026-11-14T02:00:00Z'))).toBe('closed')
    expect(aSharePhase(new Date('2026-11-15T02:00:00Z'))).toBe('closed')
    expect(livePlan(new Date('2026-11-14T02:00:00Z')).quoteIntervalMs).toBeNull()
  })

  it('上海与纽约的日期、分钟数与本地时区无关', () => {
    const now = new Date('2026-11-16T16:30:00Z')
    expect(shanghaiClock(now)).toMatchObject({ date: '2026-11-17', weekday: 2, minutes: 30 })
    expect(newYorkClock(now)).toMatchObject({ date: '2026-11-16', weekday: 1 })
  })

  it('美股时段自动处理夏令时，并保留收盘后 20 分钟宽限', () => {
    // 冬令时 EST：09:30 = 14:30Z；16:10 = 21:10Z
    expect(usSessionActive(new Date('2026-01-15T14:29:00Z'))).toBe(false)
    expect(usSessionActive(new Date('2026-01-15T14:30:00Z'))).toBe(true)
    expect(usSessionActive(new Date('2026-01-15T21:10:00Z'))).toBe(true)
    expect(usSessionActive(new Date('2026-01-15T21:21:00Z'))).toBe(false)
    // 夏令时 EDT：09:30 = 13:30Z
    expect(usSessionActive(new Date('2026-07-15T13:00:00Z'))).toBe(false)
    expect(usSessionActive(new Date('2026-07-15T13:30:00Z'))).toBe(true)
    // 纽约周末
    expect(usSessionActive(new Date('2026-11-15T15:00:00Z'))).toBe(false)
  })

  it('盘中每分钟、收盘后 5 分钟、无行情时段不抓', () => {
    // 集合竞价（09:15–09:30）不抓连续行情
    expect(livePlan(new Date('2026-11-16T01:20:00Z')).quoteIntervalMs).toBeNull()

    const morning = livePlan(new Date('2026-11-16T02:00:00Z'))
    expect(morning.quoteIntervalMs).toBe(60_000)
    expect(morning.overseasIntervalMs).toBe(30 * 60_000)

    const postclose = livePlan(new Date('2026-11-16T07:05:00Z'))
    expect(postclose.quoteIntervalMs).toBe(5 * 60_000)

    const night = livePlan(new Date('2026-11-16T15:00:00Z'))
    expect(night.quoteIntervalMs).toBeNull()
    expect(night.overseasIntervalMs).toBe(15 * 60_000)
  })

  it('工作日 16:10 后才触发收盘链路', () => {
    expect(shouldQueueDailyClose(new Date('2026-11-16T08:09:00Z'))).toBe(false)
    expect(shouldQueueDailyClose(new Date('2026-11-16T08:10:00Z'))).toBe(true)
    expect(shouldQueueDailyClose(new Date('2026-11-15T08:10:00Z'))).toBe(false)
  })

  it('模拟盘节奏按上海时间逐段到期，周末只排周复盘', () => {
    expect(paperStepsDue(new Date('2026-11-16T00:29:00Z'))).toEqual([])
    expect(paperStepsDue(new Date('2026-11-16T00:30:00Z'))).toEqual([
      { type: 'paper_preopen_check', tradeDate: '2026-11-16' },
    ])
    expect(paperStepsDue(new Date('2026-11-16T01:15:00Z')).map((step) => step.type)).toEqual([
      'paper_preopen_check',
      'paper_cutoff',
    ])
    const afterClose = paperStepsDue(new Date('2026-11-16T09:30:00Z'))
    expect(afterClose.map((step) => step.type)).toEqual([
      'paper_preopen_check',
      'paper_cutoff',
      'paper_settle',
      'paper_position_scan',
      'paper_reconcile',
      'paper_review_daily',
      'paper_evaluate_outcomes',
      'paper_cards_next_day',
      'paper_review_weekly',
    ])
    expect(paperStepsDue(new Date('2026-11-14T01:59:00Z'))).toEqual([])
    expect(paperStepsDue(new Date('2026-11-14T02:00:00Z'))).toEqual([
      { type: 'paper_review_weekly', tradeDate: '2026-11-14' },
    ])
    // 周日也排周复盘：周六停机时由周日补上同一周。
    expect(paperStepsDue(new Date('2026-11-15T02:00:00Z'))).toEqual([
      { type: 'paper_review_weekly', tradeDate: '2026-11-15' },
    ])
  })
})
