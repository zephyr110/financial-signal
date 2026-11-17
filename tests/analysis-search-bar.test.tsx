import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SearchBar from '@/components/SearchBar'

afterEach(() => {
  vi.useRealTimers()
})

describe('信号分析搜索栏', () => {
  it('默认收成一枚图标，点击后展开输入框并获得焦点', () => {
    render(<SearchBar onSearch={vi.fn()} onClear={vi.fn()} />)
    const input = screen.getByLabelText('搜索行业、公司、关键词')
    expect(input).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('button', { name: '搜索' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))

    expect(input).toHaveAttribute('tabindex', '0')
    expect(input).toHaveFocus()
  })

  it('输入两个字符后按默认分数与时间窗触发搜索', () => {
    vi.useFakeTimers()
    const onSearch = vi.fn()
    render(<SearchBar onSearch={onSearch} onClear={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.change(screen.getByLabelText('搜索行业、公司、关键词'), {
      target: { value: '半导体' },
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(onSearch).toHaveBeenCalledWith({ query: '半导体', minScore: 1, hoursBack: 168 })
  })

  it('分数与时间选择器与搜索同组，选择后回写标签', () => {
    render(<SearchBar onSearch={vi.fn()} onClear={vi.fn()} />)

    const score = screen.getByRole('button', { name: /全部/ })
    const time = screen.getByRole('button', { name: /7 天/ })
    expect(score).toHaveAttribute('aria-expanded', 'false')
    expect(time).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(score)
    expect(score).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: '≥4 分' }))
    expect(score).toHaveAttribute('aria-expanded', 'false')
    expect(score).toHaveTextContent('≥4 分')
  })

  it('空搜索时选择分数筛选会收起搜索框', () => {
    render(<SearchBar onSearch={vi.fn()} onClear={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(screen.getByLabelText('搜索行业、公司、关键词')).toHaveAttribute('tabindex', '0')

    fireEvent.click(screen.getByRole('button', { name: /全部/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '≥3 分' }))

    expect(screen.getByRole('button', { name: '搜索' })).toBeInTheDocument()
  })

  it('清空并失焦后重新收成图标', () => {
    const onClear = vi.fn()
    render(<SearchBar onSearch={vi.fn()} onClear={onClear} />)

    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    const input = screen.getByLabelText('搜索行业、公司、关键词')
    fireEvent.change(input, { target: { value: '半导体' } })
    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }))

    expect(onClear).toHaveBeenCalled()
    expect(input).toHaveValue('')

    fireEvent.blur(input)
    expect(screen.getByRole('button', { name: '搜索' })).toBeInTheDocument()
  })
})
