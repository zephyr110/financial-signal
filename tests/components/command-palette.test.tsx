import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CommandPalette } from '@/components/command-palette'

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: '/',
  query: {} as Record<string, string>,
  asPath: '/',
  isReady: true,
  replace: vi.fn(),
}))

vi.mock('next/router', () => ({ useRouter: () => routerMock }))

const originalFetch = global.fetch

beforeEach(() => {
  routerMock.pathname = '/'
  routerMock.push.mockClear()
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { sections: {} } }),
  })) as any
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('命令面板', () => {
  it('⌘K 打开并聚焦输入框，Esc 关闭后焦点回到触发元素', async () => {
    render(<CommandPalette />)
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = await screen.findByRole('combobox', { name: '搜索与命令' })
    await waitFor(() => expect(document.activeElement).toBe(input))

    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('combobox', { name: '搜索与命令' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    trigger.remove()
  })

  it('输入过滤后回车跳转页面', async () => {
    render(<CommandPalette />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByRole('combobox', { name: '搜索与命令' })
    fireEvent.change(input, { target: { value: '投研台' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(routerMock.push).toHaveBeenCalledWith('/desk')
  })

  it('中文输入法组合期间的 Enter 不触发选择', async () => {
    render(<CommandPalette />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = await screen.findByRole('combobox', { name: '搜索与命令' })
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '投研台' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(routerMock.push).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: '搜索与命令' })).toBeTruthy()
    fireEvent.compositionEnd(input)
  })

  it('方向键移动选中项，超出范围时循环', async () => {
    render(<CommandPalette />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const input = await screen.findByRole('combobox', { name: '搜索与命令' })
    fireEvent.change(input, { target: { value: '驾驶舱' } })
    const before = screen.getAllByRole('option').findIndex((el) => el.getAttribute('aria-selected') === 'true')
    expect(before).toBe(0)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option').findIndex((el) => el.getAttribute('aria-selected') === 'true')).toBe(1)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option').findIndex((el) => el.getAttribute('aria-selected') === 'true')).toBe(0)
  })
})
