import type { ReactNode } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BriefPanel, PulsePanel } from '@/components/cockpit/home-panels'
import { CockpitSelectionProvider } from '@/components/cockpit/selection-context'
import type { DashboardPulse } from '@/lib/dashboard/aggregate'

vi.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/',
    asPath: '/',
    query: {},
    isReady: true,
    push: vi.fn(),
    replace: vi.fn(),
  }),
}))

function noop() {}

function renderPanel(node: ReactNode) {
  return render(<CockpitSelectionProvider>{node}</CockpitSelectionProvider>)
}

describe('驾驶舱面板空态', () => {
  it('简报区块成功但没有数据时给出下一步入口，不留空白面板', () => {
    renderPanel(
      <BriefPanel
        section={{ ok: true, data: null }}
        loading={false}
        refreshing={false}
        onRetry={noop}
        onRefresh={noop}
      />,
    )
    expect(screen.getByText('今天还没有收盘简报')).toBeTruthy()
    expect(screen.getByRole('link', { name: '去简报页看看' }).getAttribute('href')).toBe('/today')
  })

  it('脉搏全空时只显示一处空态，不重复提示', () => {
    const emptyPulse = {
      tradeDate: null,
      asOf: '2026-11-12T08:00:00.000Z',
      market: null,
      industries: [],
      overseas: [],
      realtime: [],
      isDemo: false,
    } as unknown as DashboardPulse
    renderPanel(
      <PulsePanel
        section={{ ok: true, data: emptyPulse }}
        loading={false}
        refreshing={false}
        onRetry={noop}
        onRefresh={noop}
      />,
    )
    expect(screen.getByText('暂无脉搏数据')).toBeTruthy()
    expect(screen.queryByText('投研台还没有今天的市场判断。')).toBeNull()
  })

  it('区块失败时显示错误与重试，而不是空态', () => {
    const onRetry = vi.fn()
    renderPanel(
      <PulsePanel
        section={{ ok: false, error: '数据暂时不可用' }}
        loading={false}
        refreshing={false}
        onRetry={onRetry}
        onRefresh={noop}
      />,
    )
    expect(screen.getByText('数据暂时不可用')).toBeTruthy()
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy()
  })
})
