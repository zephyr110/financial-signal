import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import WelcomeScreen from '../../components/WelcomeScreen'

describe('WelcomeScreen', () => {
  it('renders two actions: import and skip', () => {
    render(<WelcomeScreen onImport={() => {}} onSkip={() => {}} importing={false} error={null} />)
    expect(screen.getByRole('button', { name: /导入已有数据库/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /全新开始/i })).toBeTruthy()
  })

  it('calls onImport when clicking import button', () => {
    const onImport = vi.fn()
    render(<WelcomeScreen onImport={onImport} onSkip={() => {}} importing={false} error={null} />)
    fireEvent.click(screen.getByText(/导入已有数据库/i))
    expect(onImport).toHaveBeenCalledTimes(1)
  })

  it('shows error message when import fails', () => {
    render(<WelcomeScreen onImport={() => {}} onSkip={() => {}} importing={false} error="文件格式不正确" />)
    expect(screen.getByText(/文件格式不正确/)).toBeTruthy()
  })
})
