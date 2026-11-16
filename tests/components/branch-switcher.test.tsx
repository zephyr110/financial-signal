import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BranchSwitcher } from '../../components/BranchSwitcher';

const versions = (ids: string[], index: number) => ({ ids, index });

describe('BranchSwitcher', () => {
  it('单版本不渲染', () => {
    const { container } = render(
      <BranchSwitcher versions={versions(['a'], 0)} onSelect={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('显示序号,两个方向都可切换', () => {
    const onSelect = vi.fn();
    render(<BranchSwitcher versions={versions(['a', 'b', 'c'], 1)} onSelect={onSelect} />);
    expect(screen.getByText('2 / 3')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('上一版本'));
    expect(onSelect).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByLabelText('下一版本'));
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('边界按钮禁用', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <BranchSwitcher versions={versions(['a', 'b'], 0)} onSelect={onSelect} />,
    );
    expect(screen.getByLabelText('上一版本')).toBeDisabled();
    expect(screen.getByLabelText('下一版本')).not.toBeDisabled();

    rerender(<BranchSwitcher versions={versions(['a', 'b'], 1)} onSelect={onSelect} />);
    expect(screen.getByLabelText('上一版本')).not.toBeDisabled();
    expect(screen.getByLabelText('下一版本')).toBeDisabled();
  });

  it('disabled 时两个方向都不可点', () => {
    const onSelect = vi.fn();
    render(<BranchSwitcher versions={versions(['a', 'b'], 0)} disabled onSelect={onSelect} />);
    fireEvent.click(screen.getByLabelText('下一版本'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
