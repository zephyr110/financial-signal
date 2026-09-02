/**
 * 进程内 TTL 读缓存：降低 Turso 重复全表扫描（分析页、聚合图表、搜索等）。
 * 测试环境默认 bypass，避免用例间污染。
 */

const store = new Map<string, { at: number; value: unknown }>();

export const READ_CACHE_TTL = {
  /** 分析聚合、热力图、趋势 */
  analysisAgg: 5 * 60 * 1000,
  /** 搜索 COUNT + 首屏结果 */
  search: 2 * 60 * 1000,
  /** 健康检查 pipeline 聚合 */
  pipelineHealth: 15 * 60 * 1000,
} as const;

function cacheEnabled(): boolean {
  return process.env.NODE_ENV !== 'test' && process.env.DISABLE_READ_CACHE !== '1';
}

export function readCacheKey(parts: Array<string | number | null | undefined>): string {
  return parts.map((p) => (p == null ? '' : String(p))).join('|');
}

/** 命中 TTL 则直接返回；否则执行 loader 并写入缓存 */
export async function cachedRead<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!cacheEnabled()) return loader();

  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) {
    return hit.value as T;
  }

  const value = await loader();
  store.set(key, { at: now, value });
  return value;
}

/** 测试或运维手动失效 */
export function clearReadCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
