import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 研究日志的日期选择走 shadcn Calendar：选中哪一天，提交就写哪一天，
 * 不在本地时区里被 UTC 解析挪到前一天。
 */

const replace = vi.fn()

vi.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/research', pathname: '/research', push: vi.fn(), replace }),
}))

const { JournalComposer } = await import('@/components/cockpit/journal-composer')

afterEach(() => {
  vi.unstubAllGlobals()
  replace.mockReset()
})

describe('研究日志日期选择', () => {
  it('用日历选中的日期提交，而不是浏览器原生日期输入', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<JournalComposer today="2026-11-16" theses={[]} />)

    expect(screen.queryByDisplayValue('2026-11-16')).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: '日期' })
    expect(trigger).toHaveTextContent('2026年11月16日')
    fireEvent.click(trigger)

    const grid = await screen.findByRole('grid')
    expect(grid).toBeInTheDocument()

    fireEvent.click(screen.getByText('10'))
    await waitFor(() => {
      expect(trigger).toHaveTextContent('2026年11月10日')
    })

    fireEvent.change(screen.getByLabelText('理由与当时看到的事实'), {
      target: { value: '收盘后复看了成交量与行业分化。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '写入日志' }))

    expect(await screen.findByText('已写入研究日志。')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/cockpit/journal', expect.objectContaining({
      method: 'POST',
    }))
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.entryDate).toBe('2026-11-10')
  })
})
