import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/router', () => ({
  useRouter: () => ({
    asPath: '/analysis',
    pathname: '/analysis',
    query: {},
    push: vi.fn(),
    replace: vi.fn(),
  }),
}))

const { default: FocusStocks } = await import('@/components/FocusStocks')

const stocks = {
  bullish: [{
    name: '中芯国际',
    code: '688981.SH',
    reasons: [{ text: '国产替代订单验证', stance: 'positive' }],
  }],
  bearish: [{
    name: '长电科技',
    code: null,
    reasons: [{ text: '封测价格承压', stance: 'negative' }],
  }],
  watch: [{
    name: '北方华创',
    code: '002371.SZ',
    reasons: [
      { text: '扩产利好', stance: 'positive' },
      { text: '出口管制风险', stance: 'negative' },
    ],
  }],
}

describe('事件线索重点个股', () => {
  it('默认折叠，展开后按方向分组显示有序列表和分析依据', () => {
    render(<FocusStocks stocks={stocks} />)
    const trigger = screen.getByRole('button', { name: /重点个股/ })

    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('看涨 1 · 看跌 1 · 待观察 1')
    expect(screen.queryByText('国产替代订单验证')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('heading', { name: '看涨' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '看跌' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '待观察' })).toBeInTheDocument()

    const lists = screen.getAllByRole('list')
    expect(lists).toHaveLength(3)
    lists.forEach((list) => expect(list.tagName).toBe('OL'))

    expect(screen.getByText('国产替代订单验证')).toBeInTheDocument()
    expect(screen.getByText('封测价格承压')).toBeInTheDocument()
    // 待观察给出多空两边依据，并标明倾向
    expect(screen.getByText('偏多')).toBeInTheDocument()
    expect(screen.getByText('偏空')).toBeInTheDocument()
    expect(screen.getByText(/扩产利好/)).toBeInTheDocument()
    expect(screen.getByText(/出口管制风险/)).toBeInTheDocument()

    expect(screen.getByRole('link', { name: '中芯国际' })).toHaveAttribute(
      'href',
      '/stock/688981.SH',
    )
    expect(screen.queryByRole('link', { name: '长电科技' })).toBeNull()

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('国产替代订单验证')).toBeNull()
  })

  it('空方向不显示；缺少依据时有兜底说明', () => {
    render(<FocusStocks stocks={{ bearish: [{ name: '无依据公司', code: null }] }} />)
    const trigger = screen.getByRole('button', { name: /重点个股/ })

    expect(trigger).toHaveTextContent('看跌 1')
    expect(trigger).not.toHaveTextContent('看涨')

    fireEvent.click(trigger)
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(screen.getByText(/暂无分析摘要/)).toBeInTheDocument()
  })

  it('线索详情页可默认展开依据', () => {
    render(<FocusStocks stocks={stocks} defaultOpen />)
    expect(screen.getByRole('button', { name: /重点个股/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('国产替代订单验证')).toBeInTheDocument()
  })
})
