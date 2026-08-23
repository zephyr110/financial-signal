import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import Home from '../../pages/index'

// 首页渲染链路(AppShell/AppSidebar/avatar-menu)用到 next/router 与 next-themes,
// 测试环境无完整 Next.js 运行时,给最小实现即可
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/', asPath: '/', replace: vi.fn(), push: vi.fn() }),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn(), resolvedTheme: 'light' }),
}))

// jsdom 无 window.matchMedia(ui/sidebar 的 use-mobile 钩子需要),给个最小桩
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

const baseProps = {
  todayItems: [] as any[],
  pastDates: [] as any[],
  today: '',
  error: null as string | null,
}

// jsdom 不会注入 preload 桥,测试里用 defineProperty 模拟 window.desktop
let desktopMock: any
const originalFetch = global.fetch

beforeEach(() => {
  desktopMock = {
    getInfo: vi.fn(),
    selectAndImportDb: vi.fn(),
    createFreshDb: vi.fn(),
  }
  Object.defineProperty(window, 'desktop', { value: desktopMock, configurable: true })
  // 自动刷新 effect 会 fetch /api/news(AppShell 还会 fetch /api/auth/me),统一 mock 掉
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ todayItems: [], pastDates: [] }),
  })) as any
})

afterEach(() => {
  delete (window as any).desktop
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('首页欢迎页门控(集成,防 C1 类回归)', () => {
  it('getInfo imported=false 时渲染欢迎页(导入入口)', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    render(<Home {...baseProps} />)
    expect(await screen.findByText(/欢迎使用 Financial Signal/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /导入已有数据库/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /全新开始/i })).toBeTruthy()
  })

  it('getInfo imported=true 时不渲染欢迎页', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: true })
    render(<Home {...baseProps} />)
    await waitFor(() => expect(desktopMock.getInfo).toHaveBeenCalled())
    expect(screen.queryByText(/欢迎使用 Financial Signal/)).toBeNull()
    expect(screen.getByText(/实时财经快讯/)).toBeTruthy()
  })

  it('web 模式(window.desktop 不存在)不渲染欢迎页', async () => {
    delete (window as any).desktop
    render(<Home {...baseProps} />)
    // 等自动刷新 effect 跑完,确认没有误依赖 getInfo 渲染欢迎页
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.queryByText(/欢迎使用 Financial Signal/)).toBeNull()
  })

  it('imported=false 时挂载期不拉取 /api/news(防服务端 getDb 抢先建库)', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    render(<Home {...baseProps} />)
    await screen.findByText(/欢迎使用 Financial Signal/)
    // 欢迎页展示全程不应请求 /api/news(AppShell 的 /api/auth/me 属布局,与数据
    // 拉取无关):getInfo 判定完成前不发请求,判定 imported=false 后自动刷新
    // effect 直接 return——杜绝 server 侧 getDb() 抢先建库
    expect(global.fetch).not.toHaveBeenCalledWith('/api/news', expect.anything())
    expect(desktopMock.getInfo).toHaveBeenCalledTimes(1)
  })

  it('点"全新开始"调用 createFreshDb,成功后欢迎页消失', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.createFreshDb.mockResolvedValue({ ok: true })
    render(<Home {...baseProps} />)
    await screen.findByText(/欢迎使用 Financial Signal/)
    fireEvent.click(screen.getByRole('button', { name: /全新开始/i }))
    await waitFor(() => expect(desktopMock.createFreshDb).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText(/欢迎使用 Financial Signal/)).toBeNull())
  })

  it('导入取消({ok:false, canceled:true})不显示错误、欢迎页保留', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.selectAndImportDb.mockResolvedValue({ ok: false, canceled: true })
    render(<Home {...baseProps} />)
    await screen.findByText(/欢迎使用 Financial Signal/)
    fireEvent.click(screen.getByRole('button', { name: /导入已有数据库/i }))
    await waitFor(() => expect(desktopMock.selectAndImportDb).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/导入失败/)).toBeNull()
    expect(screen.getByText(/欢迎使用 Financial Signal/)).toBeTruthy()
  })

  it('导入失败时显示错误信息、欢迎页保留', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.selectAndImportDb.mockResolvedValue({ ok: false, error: '文件格式不正确' })
    render(<Home {...baseProps} />)
    await screen.findByText(/欢迎使用 Financial Signal/)
    fireEvent.click(screen.getByRole('button', { name: /导入已有数据库/i }))
    expect(await screen.findByText(/文件格式不正确/)).toBeTruthy()
    expect(screen.getByText(/欢迎使用 Financial Signal/)).toBeTruthy()
  })

  it('getInfo 失败(IPC 异常)→ 按未导入处理渲染欢迎页,不拉取数据', async () => {
    desktopMock.getInfo.mockRejectedValue(new Error('ipc broken'))
    render(<Home {...baseProps} />)
    // 判定失败不能放行自动刷新:/api/news 会触发 server 侧 getDb() 抢先建出空库,
    // 下次启动 imported 恒 true → 欢迎页永远不再出现
    expect(await screen.findByText(/欢迎使用 Financial Signal/)).toBeTruthy()
    expect(global.fetch).not.toHaveBeenCalledWith('/api/news', expect.anything())
  })

  it('导入时 IPC 抛异常 → 显示错误信息、按钮复位、欢迎页保留', async () => {
    desktopMock.getInfo.mockResolvedValue({ imported: false })
    desktopMock.selectAndImportDb.mockRejectedValue(new Error('ipc died'))
    render(<Home {...baseProps} />)
    await screen.findByText(/欢迎使用 Financial Signal/)
    fireEvent.click(screen.getByRole('button', { name: /导入已有数据库/i }))
    expect(await screen.findByText(/导入失败/)).toBeTruthy()
    expect(screen.getByText(/欢迎使用 Financial Signal/)).toBeTruthy()
    // finally 复位 importing:按钮不再卡在"导入中…"
    expect(screen.getByRole('button', { name: /导入已有数据库/i })).not.toBeDisabled()
  })
})
