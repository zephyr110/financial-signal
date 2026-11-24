import { describe, it, expect } from 'vitest'
import { todayBriefState } from '../lib/cockpit/today-state'

describe('今日简报状态', () => {
  const today = '2026-11-24'
  const base = { today, latestMarketDate: '2026-11-23', marketOpen: true }

  it('报告日期等于今天才算当前简报', () => {
    expect(todayBriefState({ ...base, reportDate: today })).toBe('current')
  })

  it('交易日收盘数据未入库时提示收盘后生成', () => {
    expect(todayBriefState({ ...base, reportDate: '2026-11-23' })).toBe('pending-close')
  })

  it('行情已入库但简报未生成', () => {
    expect(todayBriefState({ ...base, reportDate: '2026-11-23', latestMarketDate: today })).toBe('pending-generate')
  })

  it('休市日展示最近交易日', () => {
    expect(todayBriefState({
      ...base,
      reportDate: '2026-11-20',
      latestMarketDate: '2026-11-20',
      marketOpen: false,
    })).toBe('closed')
  })

  it('日历不可用时给出保守的未知状态', () => {
    expect(todayBriefState({ ...base, reportDate: '2026-11-23', marketOpen: null })).toBe('unknown')
  })
})
