import { useEffect, useRef, useState } from 'react';

/** 两次更新的最长间隔 */
const MAX_WAIT = 2000;
/** 上次渲染耗时的倍数，超过这个时间才允许下次更新 */
const TIME_CONSUMING_RATE = 2;

/**
 * 流式 Markdown 按渲染耗时自适应节流：逐字重解析长回答容易掉帧，
 * 这里合并中间帧只提交最新内容；渲染越快节流越短。关闭时直接返回最新内容。
 */
export function useThrottledMarkdown(content: string, enable: boolean): string {
  const startRef = useRef(performance.now());
  const updatableAtRef = useRef(0);
  const [output, setOutput] = useState(content);

  useEffect(() => {
    const now = performance.now();
    updatableAtRef.current = now + Math.min(MAX_WAIT, (now - startRef.current) * TIME_CONSUMING_RATE);
  }, [output]);

  useEffect(() => {
    if (!enable) return;
    const update = () => {
      startRef.current = performance.now();
      setOutput(content);
    };
    const delay = updatableAtRef.current - performance.now();
    if (delay <= 0) {
      update();
      return;
    }
    const timer = setTimeout(update, delay);
    return () => clearTimeout(timer);
  }, [content, enable]);

  return enable ? output : content;
}
