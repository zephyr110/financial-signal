import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MOBILE_ITEMS, PRIMARY_ITEMS, SECONDARY_ITEMS, SIDEBAR_GROUPS } from '@/lib/nav'
import { MobileBottomNav } from '@/components/mobile-bottom-nav'
import { TodayTabs } from '@/components/TodayTabs'

const routerState = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('next/router', () => ({
  useRouter: () => ({
    pathname: routerState.pathname,
    asPath: routerState.pathname,
    query: {},
    isReady: true,
    replace: vi.fn(),
    push: vi.fn(),
  }),
}))

beforeEach(() => {
  routerState.pathname = '/'
  cleanup()
})

describe('侧栏信息架构', () => {
  it('顶层只保留五个模块，研究类入口收进第二组', () => {
    expect(SIDEBAR_GROUPS.map((group) => group.label)).toEqual(['主模块', '研究'])
    expect(PRIMARY_ITEMS.map((item) => item.label)).toEqual(['驾驶舱', '投研台', '自选', '持仓', '任务'])
    expect(SECONDARY_ITEMS.map((item) => item.label)).toEqual([
      '收盘简报',
      '新闻线索',
      '研究笔记',
      '信号分析',
      '研究助手',
    ])
  })

  it('驾驶舱只认根路径，不和详情页抢高亮', () => {
    const cockpit = PRIMARY_ITEMS[0]
    expect(cockpit.href).toBe('/')
    expect(cockpit.match('/')).toBe(true)
    expect(cockpit.match('/desk')).toBe(false)
    expect(cockpit.match('/stock/600519')).toBe(false)
  })

  it('个股、信号、线索详情归属各自的一级入口', () => {
    const watchlist = PRIMARY_ITEMS[2]
    const analysis = SECONDARY_ITEMS[3]
    expect(watchlist.match('/stock/600519')).toBe(true)
    expect(PRIMARY_ITEMS[1].match('/desk')).toBe(true)
    expect(analysis.match('/signal/42')).toBe(true)
    expect(analysis.match('/thread/42')).toBe(true)
    expect(analysis.match('/analytics/value')).toBe(true)
    expect(SECONDARY_ITEMS[4].match('/agent')).toBe(true)
  })

  it('手机底栏固定五个主模块', () => {
    expect(MOBILE_ITEMS.map((item) => item.href)).toEqual([
      '/',
      '/desk',
      '/watchlist',
      '/portfolio',
      '/tasks',
    ])
  })
})

describe('手机底栏', () => {
  it('根路径把“驾驶舱”标为当前页', () => {
    routerState.pathname = '/'
    render(<MobileBottomNav />)
    expect(screen.getAllByRole('link')).toHaveLength(5)
    expect(screen.getByRole('link', { name: /驾驶舱/ }).getAttribute('aria-current')).toBe('page')
  })

  it('投研台路径只高亮投研台', () => {
    routerState.pathname = '/desk'
    render(<MobileBottomNav />)
    expect(screen.getByRole('link', { name: /投研台/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: /驾驶舱/ }).getAttribute('aria-current')).toBeNull()
  })

  it('新闻线索不额外占底栏位', () => {
    routerState.pathname = '/news'
    render(<MobileBottomNav />)
    expect(screen.queryByRole('link', { name: /新闻线索/ })).toBeNull()
  })
})

describe('今日视图切换', () => {
  it('收盘简报为当前视图时只标记对应入口', () => {
    routerState.pathname = '/today'
    render(<TodayTabs />)
    expect(screen.getByRole('link', { name: /收盘简报/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: /新闻线索/ }).getAttribute('aria-current')).toBeNull()
  })

  it('新闻线索为当前视图时指向 /news', () => {
    routerState.pathname = '/news'
    render(<TodayTabs />)
    const news = screen.getByRole('link', { name: /新闻线索/ })
    expect(news.getAttribute('aria-current')).toBe('page')
    expect(news.getAttribute('href')).toBe('/news')
  })
})
