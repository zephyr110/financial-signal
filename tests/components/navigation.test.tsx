import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MOBILE_ITEMS, SIDEBAR_GROUPS } from '@/lib/nav'
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
  it('日常、研究、系统三组各自收纳对应入口', () => {
    expect(SIDEBAR_GROUPS.map((group) => group.label)).toEqual(['日常', '研究', '系统'])
    expect(SIDEBAR_GROUPS[0].items.map((item) => item.label)).toEqual(['今日', '自选', '持仓'])
    expect(SIDEBAR_GROUPS[1].items.map((item) => item.label)).toEqual([
      '投研台',
      '研究笔记',
      '信号分析',
      '研究助手',
    ])
    expect(SIDEBAR_GROUPS[2].items.map((item) => item.label)).toEqual(['任务中心'])
  })

  it('今日入口同时覆盖收盘简报与新闻线索两个视图', () => {
    const today = SIDEBAR_GROUPS[0].items[0]
    expect(today.href).toBe('/today')
    expect(today.match('/today')).toBe(true)
    expect(today.match('/')).toBe(true)
    expect(today.match('/watchlist')).toBe(false)
  })

  it('个股、信号、线索详情归属各自的一级入口', () => {
    const watchlist = SIDEBAR_GROUPS[0].items[1]
    const analysis = SIDEBAR_GROUPS[1].items[2]
    expect(watchlist.match('/stock/600519')).toBe(true)
    expect(SIDEBAR_GROUPS[1].items[0].match('/desk')).toBe(true)
    expect(analysis.match('/signal/42')).toBe(true)
    expect(analysis.match('/thread/42')).toBe(true)
    expect(analysis.match('/analytics/value')).toBe(true)
  })

  it('手机底栏固定五个主入口', () => {
    expect(MOBILE_ITEMS.map((item) => item.href)).toEqual([
      '/today',
      '/desk',
      '/watchlist',
      '/portfolio',
      '/tasks',
    ])
  })
})

describe('手机底栏', () => {
  it('根路径只把“今日”标为当前分区，不冒充当前页', () => {
    routerState.pathname = '/'
    render(<MobileBottomNav />)
    expect(screen.getAllByRole('link')).toHaveLength(5)
    expect(screen.getByRole('link', { name: /今日/ }).getAttribute('aria-current')).toBe('true')
  })

  it('收盘简报路径才把“今日”标为当前页', () => {
    routerState.pathname = '/today'
    render(<MobileBottomNav />)
    expect(screen.getByRole('link', { name: /今日/ }).getAttribute('aria-current')).toBe('page')
  })

  it('新闻线索视图不额外占底栏位', () => {
    routerState.pathname = '/'
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

  it('新闻线索为当前视图时指回根路径', () => {
    routerState.pathname = '/'
    render(<TodayTabs />)
    const news = screen.getByRole('link', { name: /新闻线索/ })
    expect(news.getAttribute('aria-current')).toBe('page')
    expect(news.getAttribute('href')).toBe('/')
  })
})
