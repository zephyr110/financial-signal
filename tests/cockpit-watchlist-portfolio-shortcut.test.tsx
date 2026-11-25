import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WatchlistItem } from '@/lib/cockpit/types'

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

describe('自选行录入持仓入口', () => {
  it('位于展开按钮左侧，并带上股票代码跳转持仓页', () => {
    render(<WatchlistRow item={item} />)
    const add = screen.getByRole('link', { name: '将贵州茅台录入持仓' })
    expect(add).toHaveAttribute('href', '/portfolio?add=600519.SH')

    const toggle = screen.getByRole('button', { name: '展开贵州茅台个股详情' })
    expect(add.closest('.ck-watch-action')).toBe(toggle.closest('.ck-watch-action'))
    expect(add.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
