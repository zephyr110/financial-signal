import { useLayoutEffect, type RefObject } from "react";

interface UseAutosizeTextareaOptions {
  /** 最大高度（px），超出后内部滚动 */
  maxHeight?: number;
}

/** 根据内容自动调整 textarea 高度 */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: UseAutosizeTextareaOptions = {}
) {
  const { maxHeight = 200 } = options;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value, maxHeight, ref]);
}
