import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StockDetail, WatchlistItem } from '@/lib/cockpit/types'

vi.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/watchlist', pathname: '/watchlist', push: vi.fn(), replace: vi.fn() }),
}))

const { WatchlistRow } = await import('@/components/cockpit/watchlist-row')

const item: WatchlistItem = {
  code: '600519.SH',
  name: '贵州茅台',
  price: 1500,
  changePct: 1.2,
  sparkline: [1480, 1490, 1500],
}

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('自选行内展开', () => {
  it('首次展开才请求个股详情，再次收起不重复请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: detail }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(<WatchlistRow item={item} />)
    // 个股页「返回自选」按此锚点定位到本行
    expect(container.querySelector('#watch-600519-SH')).not.toBeNull()
    const trigger = screen.getByRole('button', { name: /600519/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cockpit/stocks/600519.SH',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
    expect(await screen.findByText('证据链')).toBeInTheDocument()
    expect(screen.getByText('当前论点')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看完整个股页' })).toHaveAttribute(
      'href',
      '/stock/600519.SH',
    )

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    const panel = container.querySelector('.ck-watch-expand')
    expect(panel).not.toHaveClass('is-open')
    expect(panel).toHaveAttribute('inert')

    fireEvent.click(trigger)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('折叠按钮与移除按钮同排，点击可独立展开与收起', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: detail }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WatchlistRow item={item} />)
    const toggle = screen.getByRole('button', { name: '展开贵州茅台个股详情' })
    // 与移除按钮同在右侧操作区，尺寸与显隐规则一致
    expect(toggle.closest('.ck-watch-action')?.querySelector('.ck-row-action')).not.toBeNull()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '收起贵州茅台个股详情' })).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: '展开贵州茅台个股详情' })).toBeInTheDocument()
  })

  it('详情接口失败时仍保留进入个股页的出口', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: '未找到该标的' } }),
    }))

    render(<WatchlistRow item={item} />)
    fireEvent.click(screen.getByRole('button', { name: /600519/ }))

    expect(await screen.findByText('未找到该标的')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '查看完整个股页' })).toHaveAttribute(
      'href',
      '/stock/600519.SH',
    )
  })
})
