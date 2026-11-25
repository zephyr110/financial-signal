import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatchlistItem } from '@/lib/cockpit/types'
import { sortWatchlistItems } from '@/lib/cockpit/watchlist-sort'

vi.mock('next/router', () => ({
  useRouter: () => ({
    asPath: '/watchlist',
    pathname: '/watchlist',
    query: {},
    push: vi.fn(),
    replace: vi.fn(),
  }),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), resolvedTheme: 'light' }),
}))

// jsdom 缺 window.matchMedia（ui/sidebar 的 use-mobile 依赖），给最小桩
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

const { default: WatchlistPage } = await import('../pages/watchlist')

const items: WatchlistItem[] = [
  { code: '600000.SH', name: '浦发银行', price: 10, changePct: -1.2, sparkline: [] },
  { code: '600519.SH', name: '贵州茅台', price: 1500, changePct: 2.5, sparkline: [] },
  { code: '000001.SZ', name: '平安银行', price: null, changePct: null, sparkline: [] },
  { code: '000002.SZ', name: '万科A', price: 8, changePct: 0.4, sparkline: [] },
]

const originalFetch = global.fetch

beforeEach(() => {
  // AppShell / AppSidebar 挂载时会请求 /api/auth/me
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  })) as unknown as typeof fetch
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

const renderedCodes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.ck-watch-code > span:first-child')).map(
    (node) => node.textContent,
  )

describe('自选涨跌幅排序', () => {
  it('涨幅榜从高到低，跌幅榜从低到高，缺涨跌幅的始终排最后', () => {
    expect(sortWatchlistItems(items, 'default')).toEqual(items)
    expect(sortWatchlistItems(items, 'change-desc').map((item) => item.code)).toEqual([
      '600519.SH',
      '000002.SZ',
      '600000.SH',
      '000001.SZ',
    ])
    expect(sortWatchlistItems(items, 'change-asc').map((item) => item.code)).toEqual([
      '600000.SH',
      '000002.SZ',
      '600519.SH',
      '000001.SZ',
    ])
  })

  it('排序不修改入参数组', () => {
    const original = items.map((item) => item.code)
    sortWatchlistItems(items, 'change-desc')
    sortWatchlistItems(items, 'change-asc')
    expect(items.map((item) => item.code)).toEqual(original)
  })

  it('点击涨幅榜/跌幅榜后列表顺序随之变化', () => {
    const { container } = render(<WatchlistPage items={items} sourceHealth={[]} />)
    expect(renderedCodes(container)).toEqual(items.map((item) => item.code))

    const desc = screen.getByRole('button', { name: '按涨跌幅从高到低排序' })
    fireEvent.click(desc)
    expect(desc).toHaveAttribute('aria-pressed', 'true')
    expect(renderedCodes(container)).toEqual([
      '600519.SH',
      '000002.SZ',
      '600000.SH',
      '000001.SZ',
    ])

    fireEvent.click(screen.getByRole('button', { name: '按涨跌幅从低到高排序' }))
    expect(renderedCodes(container)).toEqual([
      '600000.SH',
      '000002.SZ',
      '600519.SH',
      '000001.SZ',
    ])

    fireEvent.click(screen.getByRole('button', { name: '按默认顺序排列' }))
    expect(renderedCodes(container)).toEqual(items.map((item) => item.code))
  })

  it('只有一只自选时不显示排序控件', () => {
    render(<WatchlistPage items={[items[1]]} sourceHealth={[]} />)
    expect(screen.queryByRole('group', { name: '自选个股排序' })).toBeNull()
  })
})
