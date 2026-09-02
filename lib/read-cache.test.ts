import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cachedRead, clearReadCache, readCacheKey } from './read-cache';

describe('read-cache', () => {
  beforeEach(() => {
    clearReadCache();
  });

  afterEach(() => {
    clearReadCache();
  });

  it('readCacheKey joins parts', () => {
    expect(readCacheKey(['a', 1, null])).toBe('a|1|');
  });

  it('bypasses cache in test env', async () => {
    const loader = vi.fn().mockResolvedValue(42);
    await cachedRead('k', 60_000, loader);
    await cachedRead('k', 60_000, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
