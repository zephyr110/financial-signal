import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Breadth, SourceRef, Turnover } from '@/lib/cockpit/types'
import { Disclosure } from '@/components/cockpit/bits'
import { MarketSnapshot } from '@/components/cockpit/market-pulse'

const source: SourceRef = {
  id: 'test-source',
  name: '测试源',
  tier: 1,
  asOf: '2026-10-22',
}

describe('cockpit bits', () => {
  it('Disclosure 的标题保留为真实 heading，可用 H 键导航', () => {
    render(
      <Disclosure
        title="行情、广度与成交明细"
        hint="指数走势"
        headingLevel={2}
        id="market-pulse-title"
        summaryLabel="行情、广度与成交明细，指数走势"
      >
        <p>正文</p>
      </Disclosure>,
    )
    const heading = screen.getByRole('heading', { level: 2, name: '行情、广度与成交明细' })
    expect(heading).toHaveAttribute('id', 'market-pulse-title')
    expect(screen.getByText('正文')).toBeInTheDocument()
  })

  it('缺失涨跌停统计时显示破折号，不画成 0', () => {
    const breadth: Breadth = {
      up: 10,
      flat: 2,
      down: 5,
      limitUp: 0,
      limitDown: 0,
      limitUpDownAvailable: false,
      source,
    }
    const turnover: Turnover = { value: 1000, changePct: 1.2, source }
    const { container } = render(
      <MarketSnapshot indices={[]} breadth={breadth} turnover={turnover} />,
    )
    const breakdown = container.querySelector('.ck-snapshot-breakdown')
    expect(breakdown?.textContent).toContain('涨停 — / 跌停 —')
    expect(breakdown).toHaveAttribute('title', '本次未取到涨跌停统计')
  })
})
