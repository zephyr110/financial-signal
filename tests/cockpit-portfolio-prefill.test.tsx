import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const routerState = vi.hoisted(() => ({
  query: {} as Record<string, string | string[]>,
}))

vi.mock('next/router', () => ({
  useRouter: () => ({
    asPath: '/portfolio',
    pathname: '/portfolio',
    query: routerState.query,
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

const { default: PortfolioPage } = await import('../pages/portfolio')

const originalFetch = global.fetch

beforeEach(() => {
  routerState.query = {}
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

describe('持仓页接收自选带入的代码', () => {
  it('?add= 会自动展开录入表单并预填股票代码', () => {
    routerState.query = { add: '600519.SH' }
    const { container } = render(<PortfolioPage portfolio={null} sourceHealth={[]} />)

    expect(screen.getByLabelText('股票代码')).toHaveValue('600519.SH')
    const disclosure = container.querySelector('[data-ck-disclosure]')
    expect(disclosure).toHaveClass('is-open')
  })

  it('没有 ?add= 时表单保持收起，代码为空', () => {
    const { container } = render(<PortfolioPage portfolio={null} sourceHealth={[]} />)

    expect(screen.getByLabelText('股票代码')).toHaveValue('')
    const disclosure = container.querySelector('[data-ck-disclosure]')
    expect(disclosure).not.toHaveClass('is-open')
  })
})
