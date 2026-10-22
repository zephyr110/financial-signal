import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function safeParse(str) {
  if (!str || typeof str !== 'string') return [];
  try { return JSON.parse(str); } catch { return []; }
}

/** 旧版 SW 可能把登录态页面留在 Cache Storage；退出或重登前清空本 origin 的缓存。 */
export async function clearClientCaches() {
  try {
    if (typeof caches === "undefined") return;
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    /* 清理失败不阻塞退出 */
  }
}
