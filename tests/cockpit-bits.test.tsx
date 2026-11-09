import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type {
  Breadth,
  DataQualityItem,
  SourceHealth,
  SourceRef,
  Turnover,
} from '@/lib/cockpit/types'
import {
  BriefQualityList,
  DeltaValue,
  Disclosure,
  SourceHealthRail,
} from '@/components/cockpit/bits'
import { briefQualityHint, sourceHealthHint } from '@/lib/cockpit/format'
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

describe('DeltaValue', () => {
  it('无数据时保留可读文本，不只留图标', () => {
    render(<DeltaValue value={null} />)
    expect(screen.getByText('无涨跌数据')).toBeInTheDocument()
  })

  it('有数据时读屏能听到涨跌幅前缀', () => {
    render(<DeltaValue value={1.23} />)
    expect(screen.getByText('涨跌幅：')).toBeInTheDocument()
    expect(screen.getByText('+1.23%')).toBeInTheDocument()
  })
})

describe('数据源状态', () => {
  const health = (status: SourceHealth['status'], id: string, message?: string): SourceHealth => ({
    id,
    name: `源 ${id}`,
    tier: 1,
    status,
    message,
  })

  it('未接入不计入正常分母', () => {
    expect(sourceHealthHint([
      health('ok', 'a'),
      health('inactive', 'b', '尚未接入'),
    ])).toBe('1/1 正常 · 1 未接入')
    expect(sourceHealthHint([health('inactive', 'b')])).toBe('尚未接入')
  })

  it('不截断来源，并展示未接入的具体原因', () => {
    const sources = Array.from({ length: 8 }, (_, index) =>
      health(index === 7 ? 'inactive' : 'ok', String(index), index === 7 ? '未配置 token' : undefined),
    )
    render(<SourceHealthRail sources={sources} />)
    expect(screen.getByText(/源 7/)).toBeInTheDocument()
    expect(screen.getByText(/未配置 token/)).toBeInTheDocument()
  })

  it('与状态同义的未接入说明不重复', () => {
    render(<SourceHealthRail sources={[health('inactive', 'b', '尚未接入')]} />)
    expect(screen.queryByText(/尚未接入/)).toBeNull()
    expect(screen.getByText(/未接入/)).toBeInTheDocument()
  })

  it('示例库的默认未接入长句也不重复展示', () => {
    const message = '适配器尚未接入，等待官方接口验证'
    render(<SourceHealthRail sources={[health('inactive', 'b', message)]} />)
    expect(screen.queryByText(new RegExp(message))).toBeNull()
  })

  it('简报快照的异常进入折叠摘要', () => {
    const items: DataQualityItem[] = [
      { id: 'tushare', name: 'Tushare Pro', tier: 1, status: 'stale' },
      { id: 'sse', name: '上海证券交易所', tier: 0, status: 'ok' },
    ]
    expect(briefQualityHint(items)).toBe('简报 1 项需注意')
    expect(briefQualityHint([])).toBe('')
  })
})

describe('简报数据质量快照', () => {
  it('展示生成简报时的来源、状态与说明', () => {
    const items: DataQualityItem[] = [
      {
        id: 'tushare',
        name: 'Tushare Pro',
        tier: 1,
        status: 'stale',
        asOf: '2026-11-07T07:00:00Z',
        message: '最近一次同步失败',
      },
      { id: 'sse', name: '上海证券交易所', tier: 0, status: 'inactive', message: '尚未接入' },
      {
        id: 'csrc',
        name: '中国证监会',
        tier: 0,
        status: 'inactive',
        message: '适配器尚未接入，等待官方接口验证',
      },
    ]
    render(<BriefQualityList items={items} />)
    expect(screen.getByRole('heading', { level: 3, name: '本期简报数据质量' })).toBeInTheDocument()
    expect(screen.getByText(/生成简报时的来源快照/)).toBeInTheDocument()
    expect(screen.getByText(/最近一次同步失败/)).toBeInTheDocument()
    expect(screen.queryByText(/适配器尚未接入/)).toBeNull()
  })

  it('空快照不渲染', () => {
    const { container } = render(<BriefQualityList items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
