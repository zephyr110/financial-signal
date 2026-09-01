/**
 * P2.2 观察列表 Watchlist v1 —— 纯前端 localStorage 实现。
 *
 * WatchlistService 接口抽象：v2 账号体系只需换实现（R3 缓解），
 * 数据模型（type, id, addedAt）与未来后端表一一对应。
 * 事件名约定：添加报 watchlist_add、移除报 watchlist_remove（各自独立计数，
 * 避免移除动作污染 value.ts 的"添加率"指标）。
 */
import { track } from './track';

export type WatchlistType = 'signal' | 'industry' | 'thread';

export interface WatchlistItem {
  type: WatchlistType;
  id: string;
  addedAt: string;
}

export interface WatchlistService {
  /** 全部条目（按加入时间倒序）。 */
  getAll(): WatchlistItem[];
  has(type: WatchlistType, id: string): boolean;
  /** 切换跟踪状态，返回新状态（true = 已跟踪）。 */
  toggle(type: WatchlistType, id: string): boolean;
  remove(type: WatchlistType, id: string): void;
  /** 订阅变更（跨组件/跨 tab 同步），返回退订函数。 */
  subscribe(cb: () => void): () => void;
}

const STORAGE_KEY = 'financial-signals-watchlist';
const MAX_ITEMS = 200;

function readAll(): WatchlistItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(validItem) : [];
  } catch {
    return [];
  }
}

function validItem(i: unknown): i is WatchlistItem {
  if (!i || typeof i !== 'object') return false;
  const o = i as Record<string, unknown>;
  return (
    (o.type === 'signal' || o.type === 'industry' || o.type === 'thread') &&
    typeof o.id === 'string' &&
    typeof o.addedAt === 'string'
  );
}

function writeAll(items: WatchlistItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // localStorage 满：静默丢弃，跟踪不允许影响主流程
  }
}

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((cb) => {
    try { cb(); } catch { /* 单监听器异常不影响其他 */ }
  });
}

export function subscribeWatchlist(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getAllWatchlist(): WatchlistItem[] {
  return readAll();
}

export function isWatched(type: WatchlistType, id: string): boolean {
  return readAll().some((i) => i.type === type && i.id === id);
}

/** 切换跟踪状态；返回新状态。添加上报 watchlist_add,移除上报 watchlist_remove
 *  —— 之前移除也报 watchlist_add,导致 value.ts 的"添加率"被系统性高估。 */
export function toggleWatchlist(type: WatchlistType, id: string): boolean {
  const items = readAll();
  const idx = items.findIndex((i) => i.type === type && i.id === id);
  const now = idx >= 0;
  const next = now ? items.filter((_, i) => i !== idx) : [...items, { type, id, addedAt: new Date().toISOString() }];
  writeAll(next.slice(0, MAX_ITEMS));
  track(now ? 'watchlist_remove' : 'watchlist_add', { type, id, action: now ? 'remove' : 'add' });
  notify();
  return !now;
}

export function removeWatchlist(type: WatchlistType, id: string): void {
  const next = readAll().filter((i) => !(i.type === type && i.id === id));
  writeAll(next);
  track('watchlist_remove', { type, id, action: 'remove' });
  notify();
}

// 跨 tab 同步：其他标签页的写操作通过 storage 事件触发本页刷新
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) notify();
  });
}
