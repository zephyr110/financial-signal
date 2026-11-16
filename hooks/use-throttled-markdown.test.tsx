import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThrottledMarkdown } from './use-throttled-markdown';

describe('useThrottledMarkdown', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('关闭时直接返回最新内容', () => {
    const { result, rerender } = renderHook(
      ({ content, enable }) => useThrottledMarkdown(content, enable),
      { initialProps: { content: 'a', enable: false } },
    );
    expect(result.current).toBe('a');
    rerender({ content: 'ab', enable: false });
    expect(result.current).toBe('ab');
  });

  it('开启时合并中间帧,定时器到期后提交最新内容', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ content, enable }) => useThrottledMarkdown(content, enable),
      { initialProps: { content: '', enable: true } },
    );

    rerender({ content: 'a', enable: true });
    rerender({ content: 'ab', enable: true });
    rerender({ content: 'abc', enable: true });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe('abc');
  });

  it('流式结束后关闭节流,立即显示最终内容', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ content, enable }) => useThrottledMarkdown(content, enable),
      { initialProps: { content: 'partial', enable: true } },
    );
    rerender({ content: 'final answer', enable: false });
    expect(result.current).toBe('final answer');
  });
});
