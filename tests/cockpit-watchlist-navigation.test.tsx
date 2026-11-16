import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StockDetail, WatchlistItem } from '@/lib/cockpit/types'

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

const { default: StockPage } = await import('../pages/stock/[code]')
const { default: WatchlistPage } = await import('../pages/watchlist')

const detail: StockDetail = {
  code: '600519.SH',
  name: '贵州茅台',
  exchange: 'SH',
  industry: '白酒',
  price: 1500,
  changePct: 1.2,
  asOf: '2026-11-16T07:00:00.000Z',
  bars: [],
  evidence: [],
  documents: [],
  isDemo: false,
}

const item: WatchlistItem = {
  code: '600519.SH',
  name: '贵州茅台',
  price: 1500,
  changePct: 1.2,
  sparkline: [1480, 1490, 1500],
}

const originalFetch = global.fetch
const originalScrollIntoView = (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView

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
  window.location.hash = ''
  ;(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = originalScrollIntoView
})

describe('个股页返回自选', () => {
  it('返回按钮链接到自选页并带上该个股锚点', () => {
    render(<StockPage code="600519.SH" detail={detail} sourceHealth={[]} />)
    expect(screen.getByRole('link', { name: /返回自选/ })).toHaveAttribute(
      'href',
      '/watchlist#watch-600519-SH',
    )
  })
})

describe('自选页定位返回目标', () => {
  it('hash 指向个股锚点时滚动到对应卡片并短暂高亮', () => {
    const scroll = vi.fn()
    ;(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scroll
    window.location.hash = '#watch-600519-SH'

    const { container } = render(<WatchlistPage items={[item]} sourceHealth={[]} />)
    const row = container.querySelector('#watch-600519-SH')
    expect(row).not.toBeNull()
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    expect(row).toHaveClass('is-focus-target')
  })
})
