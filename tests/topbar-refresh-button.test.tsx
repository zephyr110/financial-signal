import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TopbarRefreshButton } from '@/components/app-topbar'

describe('顶栏刷新按钮', () => {
  it('点击回调不带参数（分析页曾把 click 事件误当 AbortSignal 传给 fetch）', () => {
    const onClick = vi.fn()
    render(<TopbarRefreshButton onClick={onClick} refreshing={false} />)

    fireEvent.click(screen.getByRole('button', { name: '刷新数据' }))

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick.mock.calls[0]).toEqual([])
  })
})
