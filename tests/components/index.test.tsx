import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import CockpitPage from '../../pages/index'

// 驾驶舱渲染链路(AppShell/AppSidebar/avatar-menu)用到 next/router 与 next-themes,
// 测试环境无完整 Next.js 运行时,给最小实现即可
vi.mock('next/router', () => ({
  useRouter: () => ({
    pathname: '/',
    asPath: '/',
    query: {},
    isReady: true,
    replace: vi.fn(),
    push: vi.fn(),
    events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  }),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), resolvedTheme: 'light' }),
}))

// jsdom 无 window.matchMedia(ui/sidebar 与 Copilot 坞的断点判断需要),给个最小桩
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

// jsdom 不会注入 preload 桥,测试里用 defineProperty 模拟 window.desktop
let desktopMock: any
const originalFetch = global.fetch

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.pathname
  return input.url
}

function mockFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = fetchUrl(input)
    if (url.startsWith('/api/dashboard')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { asOf: new Date().toISOString(), sections: {} } }),
      } as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as any
}

function dashboardCalls() {
  return (global.fetch as any).mock.calls.filter((call: any[]) => fetchUrl(call[0]).startsWith('/api/dashboard'))
}

beforeEach(() => {
  desktopMock = {
    getInfo: vi.fn(),
    selectAndImportDb: vi.fn(),
    createFreshDb: vi.fn(),
  }
  Object.defineProperty(window, 'desktop', { value: desktopMock, configurable: true })
  mockFetch()
})

afterEach(() => {
  delete (window as any).desktop
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('驾驶舱欢迎页门控(集成,防 C1 类回归)', () => {
  it('getInfo imported=false 时渲染欢迎页(导入入口)', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    render(<CockpitPage />)
    expect(await screen.findByText(/欢迎使用财经信号/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /导入已有数据库/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /全新开始/i })).toBeTruthy()
  })

  it('getInfo imported=true 时不渲染欢迎页并拉取驾驶舱数据', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: true })
    render(<CockpitPage />)
    await waitFor(() => expect(desktopMock.getInfo).toHaveBeenCalled())
    expect(screen.queryByText(/欢迎使用财经信号/)).toBeNull()
    await waitFor(() => expect(dashboardCalls()).toHaveLength(1))
  })

  it('web 模式(window.desktop 不存在)不渲染欢迎页', async () => {
    delete (window as any).desktop
    render(<CockpitPage />)
    await waitFor(() => expect(dashboardCalls().length).toBeGreaterThan(0))
    expect(screen.queryByText(/欢迎使用财经信号/)).toBeNull()
  })

  it('imported=false 时挂载期不拉取 /api/dashboard(防服务端 getDb 抢先建库)', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    render(<CockpitPage />)
    await screen.findByText(/欢迎使用财经信号/)
    // 欢迎页展示全程不应请求 /api/dashboard(AppShell 的 /api/auth/me 属布局,
    // 与数据拉取无关):getInfo 判定完成前不发请求,判定 imported=false 后直接 return
    expect(dashboardCalls()).toHaveLength(0)
    expect(desktopMock.getInfo).toHaveBeenCalledTimes(1)
  })

  it('点"全新开始"调用 createFreshDb,成功后欢迎页消失', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.createFreshDb.mockResolvedValue({ ok: true })
    render(<CockpitPage />)
    await screen.findByText(/欢迎使用财经信号/)
    fireEvent.click(screen.getByRole('button', { name: /全新开始/i }))
    await waitFor(() => expect(desktopMock.createFreshDb).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText(/欢迎使用财经信号/)).toBeNull())
  })

  it('导入取消({ok:false, canceled:true})不显示错误、欢迎页保留', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.selectAndImportDb.mockResolvedValue({ ok: false, canceled: true })
    render(<CockpitPage />)
    await screen.findByText(/欢迎使用财经信号/)
    fireEvent.click(screen.getByRole('button', { name: /导入已有数据库/i }))
    await waitFor(() => expect(desktopMock.selectAndImportDb).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/导入失败/)).toBeNull()
    expect(screen.getByText(/欢迎使用财经信号/)).toBeTruthy()
  })

  it('导入失败时显示错误信息、欢迎页保留', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.selectAndImportDb.mockResolvedValue({ ok: false, error: '文件格式不正确' })
    render(<CockpitPage />)
    await screen.findByText(/欢迎使用财经信号/)
    fireEvent.click(screen.getByRole('button', { name: /导入已有数据库/i }))
    expect(await screen.findByText(/文件格式不正确/)).toBeTruthy()
    expect(screen.getByText(/欢迎使用财经信号/)).toBeTruthy()
  })

  it('getInfo 失败(IPC 异常)→ 按未导入处理渲染欢迎页,不拉取数据', async () => {
    desktopMock.getInfo.mockRejectedValue(new Error('ipc broken'))
    render(<CockpitPage />)
    // 判定失败不能放行数据请求:/api/* 会触发 server 侧 getDb() 抢先建出空库,
    // 下次启动 imported 恒 true → 欢迎页永远不再出现
    expect(await screen.findByText(/欢迎使用财经信号/)).toBeTruthy()
    expect(dashboardCalls()).toHaveLength(0)
  })

  it('导入时 IPC 抛异常 → 显示错误信息、按钮复位、欢迎页保留', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.selectAndImportDb.mockRejectedValue(new Error('ipc died'))
    render(<CockpitPage />)
    await screen.findByText(/欢迎使用财经信号/)
    fireEvent.click(screen.getByRole('button', { name: /导入已有数据库/i }))
    expect(await screen.findByText(/导入失败/)).toBeTruthy()
    expect(screen.getByText(/欢迎使用财经信号/)).toBeTruthy()
    // finally 复位 importing:按钮不再卡在"导入中…"
    expect(screen.getByRole('button', { name: /导入已有数据库/i })).not.toBeDisabled()
  })
})
