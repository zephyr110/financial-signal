import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SignalTimeline from '@/components/SignalTimeline'

vi.mock('@/lib/track', () => ({ track: vi.fn() }))

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []

  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  takeRecords = vi.fn(() => [])

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback
    this.options = options
    MockIntersectionObserver.instances.push(this)
  }
}

const items = [1, 2, 3].map((id) => ({
  id,
  analysis_id: id,
  summary: `信号 ${id}`,
  content: '',
  signal_score: 3,
  category: 'company',
  sentiment: 'positive',
  source: 'eastmoney',
  industries: [],
  companies: [],
  published_at: '2026-11-26T01:00:00Z',
}))

beforeEach(() => {
  MockIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function notify(instance: MockIntersectionObserver, isIntersecting: boolean) {
  act(() => {
    instance.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      instance as unknown as IntersectionObserver,
    )
  })
}

describe('信号时间线滚动加载', () => {
  it('列表包在大卡内，滚到底部触发下一页且同一次进入只触发一次', () => {
    const onLoadMore = vi.fn()
    const { container } = render(
      <SignalTimeline items={items} hasMore loading={false} onLoadMore={onLoadMore} />,
    )

    const card = container.firstElementChild
    expect(card).toHaveClass('bg-card', 'border', 'rounded-xl', 'p-4')
    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller).not.toBeNull()
    expect(scroller).toContainElement(screen.getByText('信号 1'))
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()

    const observer = MockIntersectionObserver.instances.at(-1)
    expect(observer).toBeDefined()
    expect(observer?.options?.root).toBe(scroller)

    notify(observer!, true)
    notify(observer!, true)
    expect(onLoadMore).toHaveBeenCalledTimes(1)
  })

  it('加载成功追加数据后自动取下一页，加载中显示提示且不再观察', () => {
    const onLoadMore = vi.fn()
    const { rerender } = render(
      <SignalTimeline items={items} hasMore loading={false} onLoadMore={onLoadMore} />,
    )

    const first = MockIntersectionObserver.instances.at(-1)!
    notify(first, true)
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    rerender(<SignalTimeline items={items} hasMore loading onLoadMore={onLoadMore} />)
    expect(screen.getByRole('status')).toHaveTextContent('加载中')
    expect(MockIntersectionObserver.instances.at(-1)).toBe(first)

    rerender(
      <SignalTimeline items={[...items, ...items]} hasMore loading={false} onLoadMore={onLoadMore} />,
    )
    const second = MockIntersectionObserver.instances.at(-1)!
    expect(second).not.toBe(first)
    notify(second, true)
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('加载失败（列表没有增长）不会原地重试，离开底部再回来才继续', () => {
    const onLoadMore = vi.fn()
    const { rerender } = render(
      <SignalTimeline items={items} hasMore loading={false} onLoadMore={onLoadMore} />,
    )

    notify(MockIntersectionObserver.instances.at(-1)!, true)
    rerender(<SignalTimeline items={items} hasMore loading onLoadMore={onLoadMore} />)
    rerender(<SignalTimeline items={items} hasMore loading={false} onLoadMore={onLoadMore} />)

    const retry = MockIntersectionObserver.instances.at(-1)!
    notify(retry, true)
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    notify(retry, false)
    notify(retry, true)
    expect(onLoadMore).toHaveBeenCalledTimes(2)
  })

  it('没有更多时不挂观察哨', () => {
    render(<SignalTimeline items={items} hasMore={false} onLoadMore={vi.fn()} />)
    expect(MockIntersectionObserver.instances).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it('空列表也使用大卡容器包裹空状态', () => {
    const { container } = render(
      <SignalTimeline items={[]} emptyMessage="暂无信号" />,
    )
    const card = container.firstElementChild
    expect(card).toHaveClass('bg-card', 'border', 'rounded-xl')
    expect(screen.getByText('暂无信号')).toBeInTheDocument()
  })
})
