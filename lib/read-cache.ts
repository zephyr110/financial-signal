/**
 * 进程内 TTL 读缓存：降低 Turso 重复全表扫描（分析页、聚合图表、搜索等）。
 * 测试环境默认 bypass，避免用例间污染。
 */

const store = new Map<string, { at: number; value: unknown }>();

export const READ_CACHE_TTL = {
  /** 分析聚合、热力图、趋势。15min:须长于分析页 ISR revalidate(600s),
   * 否则再生成时缓存恰好过期、每次 ISR 都穿透到 DB(写路径 clearReadCache 保新鲜) */
  analysisAgg: 15 * 60 * 1000,
  /** 新闻列表/可用日期(首页 ISR revalidate 300s,TTL 略长以覆盖再生成间隔) */
  newsList: 6 * 60 * 1000,
  /** 埋点价值指标聚合 + 管理端计数(低频变化,挡重复全窗口聚合) */
  eventMetrics: 5 * 60 * 1000,
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
